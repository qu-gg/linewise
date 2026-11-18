import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const historyCommand = 'vs-omp-history';
export function assertPromptAllowed(text: string): void {
  if (
    text.trim().startsWith(`/${historyCommand}`) ||
    /^\/(?:new|clear|branch|rewind|tree|fork|resume|load)(?:\s|$)/.test(text.trim())
  )
    throw new Error('Use the sidebar session and history controls for this operation.');
}

const entryId = z.string().min(1).max(128);
export const historySnapshotSchema = z
  .object({
    sessionId: entryId,
    fileName: z
      .string()
      .regex(/^[\w.-]+\.jsonl$/)
      .optional(),
    leafId: entryId.nullable(),
    entries: z.array(
      z
        .object({
          id: entryId,
          parentId: entryId.nullable(),
          type: z.string(),
          role: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>;
export const historyRequestSchema = z.discriminatedUnion('action', [
  z.object({ id: z.uuid(), action: z.literal('inspect') }).strict(),
  z
    .object({
      id: z.uuid(),
      action: z.literal('resume'),
      fileName: z
        .string()
        .regex(/^[\w.-]+\.jsonl$/)
        .max(255),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      action: z.literal('navigate'),
      sessionId: entryId,
      leafId: entryId.nullable(),
      entryId,
    })
    .strict(),
]);
export type HistoryOperation =
  | { action: 'inspect' }
  | { action: 'resume'; fileName: string }
  | Omit<Extract<z.infer<typeof historyRequestSchema>, { action: 'navigate' }>, 'id'>;
export const historyResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.uuid(), ok: z.literal(true), snapshot: historySnapshotSchema }).strict(),
  z.object({ id: z.uuid(), ok: z.literal(false), error: z.string() }).strict(),
]);

interface HistoryContext {
  isIdle(): boolean;
  navigateTree(targetId: string, options: { summarize: false }): Promise<{ cancelled: boolean }>;
  switchSession?(file: string): Promise<{ cancelled: boolean }>;
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
    getLeafId(): string | null;
    getBranch(): {
      id: string;
      parentId: string | null;
      type: string;
      message?: { role: string };
    }[];
  };
}

export interface HistoryApi {
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, context: HistoryContext): Promise<void> },
  ): void;
  appendEntry(customType: string, data: unknown): void;
}

export async function exchangeHistory(
  directory: string,
  send: (text: string) => Promise<unknown>,
  operation: HistoryOperation,
): Promise<HistorySnapshot> {
  const id = randomUUID();
  const request = path.join(directory, `request-${id}.json`);
  const response = path.join(directory, `response-${id}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(request, JSON.stringify(historyRequestSchema.parse({ ...operation, id })), {
      mode: 0o600,
      flag: 'wx',
    });
    await send(`/${historyCommand} ${id}`);
    if ((await stat(response)).size > 2 * 1024 * 1024)
      throw new Error('History response exceeds the supported size.');
    const result = historyResponseSchema.parse(JSON.parse(await readFile(response, 'utf8')));
    if (result.id !== id) throw new Error('History response identity mismatch.');
    if (!result.ok) throw new Error(result.error);
    return result.snapshot;
  } finally {
    await Promise.all(
      [request, response, `${response}.tmp`].map((file) => rm(file, { force: true })),
    );
  }
}

function snapshot(context: HistoryContext): HistorySnapshot {
  const file = context.sessionManager.getSessionFile?.();
  return historySnapshotSchema.parse({
    sessionId: context.sessionManager.getSessionId(),
    fileName: file ? path.basename(file) : undefined,
    leafId: context.sessionManager.getLeafId(),
    entries: context.sessionManager.getBranch().map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      role: entry.message?.role,
    })),
  });
}

async function resumePrivateSession(fileName: string, context: HistoryContext): Promise<void> {
  const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
  if (!artifacts || !context.switchSession)
    throw new Error('Private session resume is unavailable.');
  const root = await realpath(artifacts);
  const file = await realpath(path.join(root, fileName));
  if (path.dirname(file) !== root || !(await stat(file)).isFile())
    throw new Error('Session resume escaped private storage.');
  if ((await context.switchSession(file)).cancelled)
    throw new Error('Session resume was cancelled.');
}

async function navigateHistory(
  api: HistoryApi,
  request: Extract<z.infer<typeof historyRequestSchema>, { action: 'navigate' }>,
  context: HistoryContext,
): Promise<void> {
  const before = snapshot(context);
  if (request.sessionId !== before.sessionId || request.leafId !== before.leafId)
    throw new Error('History changed; refresh before retrying.');
  const targetIndex = before.entries.findIndex((entry) => entry.id === request.entryId);
  const target = before.entries[targetIndex];
  if (!target) throw new Error('The history target is not on the active branch.');
  const retained = before.entries
    .slice(0, targetIndex + (target.role === 'user' ? 0 : 1))
    .map((entry) => entry.id);
  const result = await context.navigateTree(target.id, { summarize: false });
  if (result.cancelled) throw new Error('History navigation was cancelled.');
  const after = snapshot(context);
  if (
    after.entries.length !== retained.length ||
    after.entries.some((entry, index) => entry.id !== retained[index])
  ) {
    throw new Error('OMP did not select the exact requested prefix; do not continue this session.');
  }
  api.appendEntry('vs-omp.history', { requestId: request.id });
}

export default function installHistory(api: HistoryApi): void {
  const directory = process.env.VS_OMP_HISTORY_DIR;
  if (!directory) return;
  api.registerCommand(historyCommand, {
    description: 'Private editor history control',
    handler: async (args, context) => {
      const id = z.uuid().parse(args.trim());
      let response: z.infer<typeof historyResponseSchema>;
      try {
        const requestFile = path.join(directory, `request-${id}.json`);
        if ((await stat(requestFile)).size > 4096)
          throw new Error('History request exceeds the supported size.');
        const request = historyRequestSchema.parse(JSON.parse(await readFile(requestFile, 'utf8')));
        if (request.id !== id || !context.isIdle())
          throw new Error('History inspection requires an idle session.');
        if (request.action === 'resume') await resumePrivateSession(request.fileName, context);
        if (request.action === 'navigate') await navigateHistory(api, request, context);
        response = { id, ok: true, snapshot: snapshot(context) };
      } catch (error) {
        response = {
          id,
          ok: false,
          error: error instanceof Error ? error.message : 'History inspection failed.',
        };
      }
      const target = path.join(directory, `response-${id}.json`);
      await writeFile(`${target}.tmp`, JSON.stringify(response), { mode: 0o600, flag: 'wx' });
      await rename(`${target}.tmp`, target);
    },
  });
}
