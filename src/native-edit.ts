import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { EditStore, EditWriteRequest } from '@oh-my-pi/pi-natives';
import * as nativeRuntime from '@oh-my-pi/pi-natives';
import { checkedPath, pathReason, readTarget } from './file-policy.js';
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
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    defaultInactive: boolean;
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

async function prepare(
  runtime: Runtime,
  context: Context,
  params: { input: string },
  snapshots: EditStore,
) {
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
  const before = new Map<string, string | null>();
  for (const target of inspection.paths) {
    const canonical = await checkedPath(target, context.cwd);
    if (path.resolve(context.cwd, target) !== canonical)
      throw new Error('Native edits through symbolic-link aliases are not supported.');
    const content = await diskText(canonical);
    if (content !== null && content !== snapshots.headText(canonical))
      throw new Error('Read the saved file again before native editing.');
    before.set(canonical, content);
  }
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

async function recordRead(
  result: Result,
  context: Context,
  snapshots: () => EditStore,
): Promise<void> {
  if (!['read', 'write'].includes(result.toolName) || result.isError) return;
  const plain = readTarget(result.input.path);
  if (pathReason(plain)) return;
  const target = await checkedPath(plain, context.cwd).catch(() => undefined);
  if (!target) return;
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) return;
  const current = snapshots();
  const tag = current.recordSnapshotFile(target, result.toolName === 'read' ? [0] : undefined);
  if (tag)
    result.content.forEach((block) => {
      if (block.type === 'text' && block.text)
        current.recordSeenLinesFromBody(target, tag, block.text);
    });
}

function getStore(native: Runtime, stores: Map<string, EditStore>, context: Context): EditStore {
  const id = context.sessionManager.getSessionId();
  if (!stores.has(id)) stores.set(id, new native.EditStore());
  return stores.get(id)!;
}

export async function installNativeEdit(api: NativeEditApi, runtime?: Runtime): Promise<void> {
  const native = runtime ?? nativeRuntime;
  const stores = new Map<string, EditStore>();
  for (const event of ['session_tree', 'session_switch', 'session_shutdown'] as const)
    api.on(event, () => stores.clear());
  api.on('tool_result', async (result, context) => {
    if (result.toolName === 'edit') {
      if (result.isError) stores.clear();
      await cleanupPermit(directory(), result.toolCallId);
      return;
    }
    await recordRead(result, context, () => getStore(native, stores, context));
  });
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
      const params = parameters.parse(input);
      const capture = await prepare(native, context, params, getStore(native, stores, context));
      signal?.throwIfAborted();
      const session = new native.EditSession(getStore(native, stores, context), {
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
        if (outcome.isError) {
          stores.clear();
          if (mutations.length)
            throw new Error('Native edit failed after staging; no host mutation was submitted.');
        } else if (mutations.length) {
          signal?.throwIfAborted();
          await exchangeMutations(directory(), mutations, signal, toolCallId);
          signal?.throwIfAborted();
        }
        return {
          content: [{ type: 'text', text: outcome.text }],
          isError: outcome.isError,
          details: { files: outcome.files },
        };
      } catch (error) {
        stores.clear();
        throw error;
      } finally {
        session.close();
      }
    },
  });
}
