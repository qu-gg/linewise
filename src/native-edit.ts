import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { EditStore, EditWriteRequest } from '@oh-my-pi/pi-natives';
import * as nativeRuntime from '@oh-my-pi/pi-natives';
import { checkedPath, lineNumbersForRead, pathReason, readTarget } from './file-policy.js';
import { cleanupPermit, exchangeMutations, stagePermit } from './mutations.js';
import type { Mutation } from './mutations.js';

type Runtime = Pick<
  typeof import('@oh-my-pi/pi-natives'),
  'EditSession' | 'EditStore' | 'editInspect' | 'editDescription'
>;
interface Context {
  cwd: string;
  sessionManager: { getSessionId(): string };
}
interface Result {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: { type: string; text?: string }[];
  isError: boolean;
}
export interface NativeEditApi {
  pi?: { getEditStore?: (context: Context) => EditStore };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    defaultInactive: boolean;
    strict?: boolean;
    approval: 'read' | 'write';
    execute(
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      context: Context,
    ): Promise<unknown>;
  }): void;
  on(
    event: 'tool_call',
    handler: (
      event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
      context: Context,
    ) => Promise<void>,
  ): void;
  on(event: 'tool_result', handler: (result: Result, context: Context) => Promise<void>): void;
  on(event: 'session_tree' | 'session_switch' | 'session_shutdown', handler: () => void): void;
}

function directory(): string {
  const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
  if (!artifacts) throw new Error('Private mutation storage is unavailable.');
  return path.join(artifacts, 'mutations');
}

async function diskText(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectTargets(
  runtime: Runtime,
  context: Context,
  params: { input: string },
): Promise<{ inspection: ReturnType<Runtime['editInspect']>; destinations: Map<string, string> }> {
  const inspection = runtime.editInspect('hashline', JSON.stringify(params));
  if (!inspection.paths.length || inspection.paths.length > 8)
    throw new Error('Native edits require one to eight supported text targets.');
  const destinations = new Map<string, string>();
  for (const operation of inspection.fileOps) {
    if (operation.kind === 'move' && operation.to)
      destinations.set(
        await checkedPath(operation.path, context.cwd),
        await checkedPath(operation.to, context.cwd),
      );
  }
  return { inspection, destinations };
}

async function capturePreimages(
  inspection: ReturnType<Runtime['editInspect']>,
  context: Context,
  snapshots: EditStore,
  shared: boolean,
): Promise<Map<string, string | null>> {
  const before = new Map<string, string | null>();
  for (const target of inspection.paths) {
    const canonical = await checkedPath(target, context.cwd);
    if (path.resolve(context.cwd, target) !== canonical)
      throw new Error('Native edits through symbolic-link aliases are not supported.');
    const content = await diskText(canonical);
    const head = snapshots.headText(canonical);
    if (content !== null && head === null)
      throw new Error('Read the saved file again before native editing.');
    if (!shared && content !== null && content !== head)
      throw new Error('Read the saved file again before native editing.');
    before.set(canonical, content === null ? null : head);
  }
  return before;
}

async function prepare(
  runtime: Runtime,
  context: Context,
  params: { input: string },
  snapshots: EditStore,
  shared: boolean,
) {
  const { inspection, destinations } = await inspectTargets(runtime, context, params);
  const before = await capturePreimages(inspection, context, snapshots, shared);
  return { before, destinations };
}

function toMutation(
  request: EditWriteRequest,
  capture: Awaited<ReturnType<typeof prepare>>,
): Mutation {
  if (!capture.before.has(request.path))
    throw new Error('Native edit resolved an uncaptured target.');
  const before = capture.before.get(request.path)!;
  if (request.op === 'delete' && before !== null)
    return { op: 'delete', path: request.path, before };
  if (request.content === undefined) throw new Error('Native edit omitted its text postimage.');
  if (request.op === 'move') {
    if (
      before === null ||
      !request.moveTo ||
      capture.destinations.get(request.path) !== request.moveTo
    )
      throw new Error('Unsupported native move.');
    return {
      op: 'move',
      path: request.path,
      before,
      content: request.content,
      destination: request.moveTo,
    };
  }
  if (!['create', 'update'].includes(request.op)) throw new Error('Unsupported native mutation.');
  return { op: 'write', path: request.path, before, content: request.content };
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

async function readableTarget(result: Result, context: Context): Promise<string | undefined> {
  if (!['read', 'write'].includes(result.toolName) || result.isError) return;
  let plain: string;
  try {
    plain = readTarget(result.input.path);
  } catch {
    return;
  }
  if (pathReason(plain)) return;
  const target = await checkedPath(plain, context.cwd).catch(() => undefined);
  if (!target) return;
  const metadata = await stat(target).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size > 1024 * 1024) return;
  return target;
}

function recordDisplayed(result: Result, store: EditStore, target: string, tag: string): void {
  result.content.forEach((block) => {
    if (block.type === 'text' && block.text) store.recordSeenLinesFromBody(target, tag, block.text);
  });
}

function recordRequested(result: Result, store: EditStore, target: string, tag: string): void {
  if (result.toolName !== 'read' || store.seenLines(target, tag)?.length) return;
  const text = store.headText(target);
  if (text === null) return;
  const lines = lineNumbersForRead(result.input.path, lineCount(text));
  if (lines.length) store.recordSeenLines(target, tag, lines);
}

async function recordRead(
  result: Result,
  context: Context,
  store: EditStore,
  preserveExisting: boolean,
): Promise<void> {
  const target = await readableTarget(result, context);
  if (!target) return;
  if (preserveExisting && store.headText(target) !== null) return;
  const tag = store.recordSnapshotFile(target);
  if (!tag) return;
  recordDisplayed(result, store, target, tag);
  recordRequested(result, store, target, tag);
}

function privateStore(
  native: Runtime,
  stores: Map<string, EditStore>,
  context: Context,
): EditStore {
  const id = context.sessionManager.getSessionId();
  if (!stores.has(id)) stores.set(id, new native.EditStore());
  return stores.get(id)!;
}

function sharedStore(
  api: NativeEditApi,
  stores: Map<string, EditStore>,
  context: Context,
): EditStore | undefined {
  try {
    const shared = api.pi?.getEditStore?.(context);
    if (!shared) return undefined;
    const key = `shared:${context.sessionManager.getSessionId()}`;
    const cached = stores.get(key);
    if (cached && cached !== shared) return cached;
    stores.set(key, shared);
    return shared;
  } catch {
    return undefined;
  }
}

async function runSession(
  native: Runtime,
  params: { input: string },
  store: EditStore,
  context: Context,
  capture: Awaited<ReturnType<typeof prepare>>,
) {
  const session = new native.EditSession(store, {
    cwd: context.cwd,
    mode: 'hashline',
    allowFuzzy: false,
    fuzzyThreshold: 1,
    enforceSeenLines: true,
    maxColumns: 0,
    blockAutoGenerated: true,
    planActive: false,
    urlSchemes: [],
    urlAliasSchemes: [],
    planWritableRoots: [],
    homeDir: os.homedir(),
    rawInput: false,
  });
  try {
    session.setArgsJson(JSON.stringify(params));
    session.finish();
    const mutations: Mutation[] = [];
    const outcome = await session.apply({ lspFlush: false }, async (error, request) => {
      if (error) throw error;
      mutations.push(toMutation(request, capture));
      return { written: request.content ?? '' };
    });
    return { outcome, mutations };
  } finally {
    session.close();
  }
}

function registerToolResult(
  api: NativeEditApi,
  native: Runtime,
  stores: Map<string, EditStore>,
  pendingReads: Map<string, Promise<void>>,
): void {
  api.on('tool_result', async (result, context) => {
    const id = context.sessionManager.getSessionId();
    const task = (async () => {
      if (result.toolName === 'edit') {
        await cleanupPermit(directory(), result.toolCallId);
        return;
      }
      const shared = sharedStore(api, stores, context);
      const store = shared ?? privateStore(native, stores, context);
      await recordRead(result, context, store, Boolean(shared));
    })().finally(() => {
      if (pendingReads.get(id) === task) pendingReads.delete(id);
    });
    pendingReads.set(id, task);
    return task;
  });
}

async function commitOutcome(
  outcome: Awaited<ReturnType<typeof runSession>>['outcome'],
  mutations: Mutation[],
  signal: AbortSignal | undefined,
  toolCallId: string,
): Promise<void> {
  if (outcome.isError && mutations.length)
    throw new Error('Native edit failed after staging; no host mutation was submitted.');
  if (outcome.isError || !mutations.length) return;
  signal?.throwIfAborted();
  await exchangeMutations(directory(), mutations, signal, toolCallId);
  signal?.throwIfAborted();
}

function registerEditTool(
  api: NativeEditApi,
  native: Runtime,
  stores: Map<string, EditStore>,
  pendingReads: Map<string, Promise<void>>,
): void {
  const parameters = z.object({ input: z.string().max(128 * 1024) });
  api.on('tool_call', async (event) => {
    if (event.toolName === 'edit')
      await stagePermit(directory(), event.toolCallId, parameters.parse(event.input).input);
  });
  api.registerTool({
    name: 'edit',
    label: 'Edit',
    approval: 'write',
    defaultInactive: true,
    description: native.editDescription('hashline'),
    parameters: z.toJSONSchema(parameters),
    async execute(toolCallId, input, signal, _update, context) {
      signal?.throwIfAborted();
      const id = context.sessionManager.getSessionId();
      await pendingReads.get(id)?.catch(() => {});
      const params = parameters.parse(input);
      const shared = sharedStore(api, stores, context);
      const store = shared ?? privateStore(native, stores, context);
      const capture = await prepare(native, context, params, store, Boolean(shared));
      signal?.throwIfAborted();
      let result: Awaited<ReturnType<typeof runSession>>;
      try {
        result = await runSession(native, params, store, context, capture);
      } catch (error) {
        stores.clear();
        pendingReads.delete(id);
        throw error;
      }
      const { outcome, mutations } = result;
      await commitOutcome(outcome, mutations, signal, toolCallId);
      return {
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError,
        details: { files: outcome.files },
      };
    },
  });
}

export async function installNativeEdit(api: NativeEditApi, runtime?: Runtime): Promise<void> {
  const native = runtime ?? nativeRuntime;
  const stores = new Map<string, EditStore>();
  const pendingReads = new Map<string, Promise<void>>();
  for (const event of ['session_tree', 'session_switch', 'session_shutdown'] as const)
    api.on(event, () => {
      stores.clear();
      pendingReads.clear();
    });
  registerToolResult(api, native, stores, pendingReads);
  registerEditTool(api, native, stores, pendingReads);
}
