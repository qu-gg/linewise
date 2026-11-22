import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { shellRequest, shellPermission } from './shell-policy.js';
import { editorRequest } from './editor-policy.js';
import { questionRequest } from './question-policy.js';
import { browserRequest } from './browser-policy.js';
import { renameRequest } from './rename-policy.js';
import { taskRequest } from './task-policy.js';
import { fetchRequest } from './fetch-policy.js';
import { codeActionRequest } from './code-action-policy.js';
import { notebookRequest } from './notebook-policy.js';

export const mutationCommand = 'vs-omp-mutation';
export function permissionInput(input: Record<string, unknown>): string | undefined {
  if (Object.keys(input).length === 1 && typeof input.input === 'string') return input.input;
  for (const schema of [renameRequest, taskRequest, codeActionRequest, notebookRequest]) {
    const parsed = schema.safeParse(input);
    if (parsed.success) return JSON.stringify(parsed.data);
  }
  return shellPermission(input);
}

const text = z.string().max(1024 * 1024);
const target = z.string().min(1).max(4096);
const toolIdentity = z
  .string()
  .min(1)
  .max(16 * 1024);
export const mutationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('notebook_edit'), request: notebookRequest }).strict(),
  z.object({ op: z.literal('code_action'), request: codeActionRequest }).strict(),
  z.object({ op: z.literal('fetch'), request: fetchRequest }).strict(),
  z.object({ op: z.literal('task'), request: taskRequest }).strict(),
  z.object({ op: z.literal('rename'), request: renameRequest }).strict(),
  z.object({ op: z.literal('browser'), request: browserRequest }).strict(),
  z.object({ op: z.literal('questions'), request: questionRequest }).strict(),
  z.object({ op: z.literal('editor'), request: editorRequest }).strict(),
  z.object({ op: z.literal('shell'), request: shellRequest }).strict(),
  z.object({ op: z.literal('access'), path: target }).strict(),
  z.object({ op: z.literal('read'), path: target }).strict(),
  z
    .object({ op: z.literal('write'), path: target, before: text.nullable(), content: text })
    .strict(),
  z.object({ op: z.literal('delete'), path: target, before: text }).strict(),
  z
    .object({
      op: z.literal('move'),
      path: target,
      before: text,
      content: text,
      destination: target,
    })
    .strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;
export function isReviewedService(
  mutation: Mutation,
): mutation is Extract<Mutation, { op: 'rename' | 'code_action' | 'notebook_edit' }> {
  return ['rename', 'code_action', 'notebook_edit'].includes(mutation.op);
}
const requestSchema = z
  .object({
    id: z.uuid(),
    scope: z.uuid().optional(),
    toolCallId: toolIdentity.optional(),
    mutations: z.array(mutationSchema).max(8),
  })
  .strict();
const scopeSchema = z.object({ id: z.uuid() }).strict();
const permitSchema = z
  .object({ id: toolIdentity, scope: z.uuid(), input: z.string().max(128 * 1024) })
  .strict();
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.uuid(), ok: z.literal(true), text: text.nullable() }).strict(),
  z.object({ id: z.uuid(), ok: z.literal(false), error: z.string().max(2000) }).strict(),
]);

export function mutationId(title: string): string | undefined {
  const prefix = `${mutationCommand} `;
  if (!title.startsWith(prefix)) return;
  const id = title.slice(prefix.length);
  return z.uuid().safeParse(id).success ? id : undefined;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory || (await lstat(directory)).mode & 0o077)
    throw new Error('Mutation control storage must be a private canonical directory.');
}

async function readEnvelope(file: string): Promise<unknown> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024 || metadata.mode & 0o077)
    throw new Error('Invalid private mutation envelope.');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function stageMutation(
  directory: string,
  id: string,
  mutations: Mutation[],
  scope?: string,
  toolCallId?: string,
): Promise<void> {
  await privateDirectory(directory);
  const request = requestSchema.parse({ id, mutations, scope, toolCallId });
  const target = path.join(directory, `request-${request.id}.json`);
  await writeFile(`${target}.tmp`, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
  await rename(`${target}.tmp`, target);
}

export async function cleanupMutation(
  directory: string,
  id: string,
  owner: 'caller' | 'broker' = 'caller',
): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new Error('Invalid mutation identity.');
  const files = [`request-${id}.json`, `request-${id}.json.tmp`, `response-${id}.json`];
  if (owner === 'broker') files.push(`response-${id}.json.tmp`);
  await Promise.all(files.map((file) => rm(path.join(directory, file), { force: true })));
}

export async function completeMutation(directory: string, id: string): Promise<string | null> {
  if (!z.uuid().safeParse(id).success) throw new Error('Invalid mutation identity.');
  try {
    const result = responseSchema.parse(
      await readEnvelope(path.join(directory, `response-${id}.json`)),
    );
    if (result.id !== id) throw new Error('Mutation response identity mismatch.');
    if (!result.ok) throw new Error(result.error);
    return result.text;
  } finally {
    await cleanupMutation(directory, id);
  }
}

export async function exchangeMutation(
  directory: string,
  mutation: Mutation,
  dispatch: (title: string) => Promise<void>,
): Promise<string | null> {
  const id = randomUUID();
  const request = path.join(directory, `request-${id}.json`);
  const response = path.join(directory, `response-${id}.json`);
  await privateDirectory(directory);
  try {
    await writeFile(request, JSON.stringify(requestSchema.parse({ id, mutations: [mutation] })), {
      mode: 0o600,
      flag: 'wx',
    });
    await dispatch(`${mutationCommand} ${id}`);
    const result = responseSchema.parse(await readEnvelope(response));
    if (result.id !== id) throw new Error('Mutation response identity mismatch.');
    if (!result.ok) throw new Error(result.error);
    return result.text;
  } finally {
    await cleanupMutation(directory, id);
  }
}

export async function serveMutation(
  directory: string,
  id: string,
  apply: (mutation: Mutation, toolCallId?: string) => Promise<string | null>,
  scope?: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) throw new Error('Invalid mutation identity.');
  await privateDirectory(directory);
  const response = path.join(directory, `response-${id}.json`);
  let result: z.infer<typeof responseSchema>;
  let completed = 0;
  try {
    const request = requestSchema.parse(
      await readEnvelope(path.join(directory, `request-${id}.json`)),
    );
    if (request.id !== id) throw new Error('Mutation request identity mismatch.');
    if (request.scope !== scope) throw new Error('Mutation belongs to a retired prompt.');
    let text: string | null = null;
    for (const mutation of request.mutations) {
      text = await apply(mutation, request.toolCallId);
      completed++;
    }
    result = { id, ok: true, text };
  } catch (error) {
    result = {
      id,
      ok: false,
      error:
        `${error instanceof Error ? error.message : 'Mutation was refused.'} (${completed} operations completed; completed or interrupted changes remain in review.)`.slice(
          0,
          2000,
        ),
    };
  }
  await writeFile(`${response}.tmp`, JSON.stringify(responseSchema.parse(result)), {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(`${response}.tmp`, response);
  return result.ok;
}

export class MutationBroker {
  private readonly id = randomUUID();
  private readonly received = new Set<string>();
  private readonly permits = new Set<string>();
  private pending = Promise.resolve();
  private closed = false;
  private failure: unknown;
  private watcher: ReturnType<typeof watch> | undefined;

  constructor(
    private readonly directory: string,
    private readonly apply: (mutation: Mutation, toolCallId?: string) => Promise<string | null>,
    private readonly signal: AbortSignal,
  ) {}

  async start(): Promise<void> {
    this.signal.throwIfAborted();
    await privateDirectory(this.directory);
    this.watcher = watch(this.directory, (_event, file) => this.receive(file));
    this.watcher.on('error', (error) => {
      this.failure = error;
      this.closed = true;
    });
    const temporary = path.join(this.directory, `active-${this.id}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ id: this.id }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'active.json'));
      this.signal.throwIfAborted();
    } catch (error) {
      this.watcher.close();
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async permit(id: string, input: unknown): Promise<boolean> {
    if (this.closed || !toolIdentity.safeParse(id).success || typeof input !== 'string')
      return false;
    this.signal.throwIfAborted();
    const target = permitPath(this.directory, id);
    try {
      const permit = permitSchema.parse(await readEnvelope(target));
      if (permit.id !== id || permit.scope !== this.id || permit.input !== input) return false;
      await rm(target);
      this.signal.throwIfAborted();
      return !this.closed;
    } catch {
      return false;
    }
  }

  private receive(file: string | null): void {
    if (this.trackPermit(file)) return;
    const match = /^request-([a-f0-9-]+)\.json$/.exec(file ?? '');
    const id = match?.[1];
    if (!id || this.closed || this.received.has(id)) return;
    if (!z.uuid().safeParse(id).success) return;
    if (this.received.size >= 256) {
      this.failure = new Error('Mutation request limit reached.');
      this.closed = true;
      return;
    }
    this.received.add(id);
    this.pending = this.pending
      .then(async () => {
        await serveMutation(
          this.directory,
          id,
          async (mutation, toolCallId) => {
            this.signal.throwIfAborted();
            if (this.closed) throw new Error('Mutation belongs to a retired prompt.');
            return this.apply(mutation, toolCallId);
          },
          this.id,
        );
      })
      .catch((error: unknown) => {
        this.failure = error;
        this.closed = true;
      });
  }

  private trackPermit(file: string | null): boolean {
    const id = /^permit-([a-f0-9]{64})\.json$/.exec(file ?? '')?.[1];
    if (!id) return false;
    if (this.permits.size >= 256) {
      this.failure = new Error('Permission request limit reached.');
      this.closed = true;
    } else this.permits.add(id);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcher?.close();
    const active = path.join(this.directory, 'active.json');
    const scope = await readEnvelope(active).catch(() => undefined);
    if (scopeSchema.safeParse(scope).data?.id === this.id) await rm(active);
    await this.pending;
    await Promise.all(
      [...this.received].map((id) => cleanupMutation(this.directory, id, 'broker')),
    );
    await Promise.all(
      [...this.permits].map((id) =>
        rm(path.join(this.directory, `permit-${id}.json`), { force: true }),
      ),
    );
    if (this.failure)
      throw new Error('Native mutation broker failed closed.', { cause: this.failure });
  }
}

function permitPath(directory: string, id: string): string {
  const key = createHash('sha256').update(toolIdentity.parse(id)).digest('hex');
  return path.join(directory, `permit-${key}.json`);
}

export async function stagePermit(directory: string, id: string, input: string): Promise<void> {
  const scope = scopeSchema.parse(await readEnvelope(path.join(directory, 'active.json')));
  const permit = permitSchema.parse({ id, scope: scope.id, input });
  await writeFile(permitPath(directory, permit.id), JSON.stringify(permit), {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    const current = scopeSchema.parse(await readEnvelope(path.join(directory, 'active.json')));
    if (current.id !== scope.id) throw new Error('Permission belongs to a retired prompt.');
  } catch (error) {
    await cleanupPermit(directory, id);
    throw error;
  }
}

export async function cleanupPermit(directory: string, id: string): Promise<void> {
  await rm(permitPath(directory, id), { force: true });
}

export async function exchangeMutations(
  directory: string,
  mutations: Mutation[],
  signal?: AbortSignal,
  toolCallId?: string,
): Promise<void> {
  await exchangeResult(directory, mutations, signal, toolCallId);
}

export async function exchangeResult(
  directory: string,
  mutations: Mutation[],
  signal?: AbortSignal,
  toolCallId?: string,
): Promise<string | null> {
  signal?.throwIfAborted();
  const scope = scopeSchema.parse(await readEnvelope(path.join(directory, 'active.json')));
  const id = randomUUID();
  const watcher = watch(directory, { signal });
  try {
    const active = path.join(directory, 'active.json');
    const assertScope = async () => {
      const current = scopeSchema.parse(await readEnvelope(active));
      if (current.id !== scope.id) throw new Error('Mutation belongs to a retired prompt.');
    };
    const completed = new Promise<void>((resolve, reject) => {
      watcher.on('change', (_event, file) => {
        if (file === `response-${id}.json`) resolve();
        if (file === 'active.json') void assertScope().catch(reject);
      });
      watcher.on('error', reject);
      watcher.on('close', () => reject(new Error('Native mutation response wait closed.')));
    });
    const publish = async () => {
      await stageMutation(directory, id, mutations, scope.id, toolCallId);
      await assertScope();
    };
    await Promise.all([publish(), completed]);
    signal?.throwIfAborted();
    return await completeMutation(directory, id);
  } finally {
    watcher.close();
    await cleanupMutation(directory, id);
  }
}
