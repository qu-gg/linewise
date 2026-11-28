import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { questionAnswers } from './questions.js';
import { historySnapshotSchema } from './history.js';
import type { HistorySnapshot } from './history.js';
import { retentionPolicy } from './storage-policy.js';
import { imageSchema } from './image-policy.js';
import { permissionMode } from './terminal-policy.js';
import { recordChunkMetrics, streamMetrics } from './stream-metrics.js';
const block = z.object({
  id: z.string(),
  kind: z.enum(['text', 'thought', 'tool', 'plan']),
  text: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  input: z.string().optional(),
  toolKind: z.string().optional(),
  toolName: z.string().max(100).optional(),
  command: z.string().optional(),
  receivedAt: z.number().finite().nonnegative().optional(),
  model: z.string().optional(),
  entries: z
    .array(
      z.object({
        content: z.string().max(2048),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .max(100)
    .optional(),
});
const attachment = z
  .object({
    id: z.string().optional(),
    kind: z.enum(['selection', 'file', 'resource', 'diagnostics', 'image']).optional(),
    label: z.string(),
    uri: z.string(),
    text: z.string().max(128_000),
    image: imageSchema.optional(),
  })
  .refine(
    (value) => (value.kind === 'image') === Boolean(value.image),
    'Image attachment kind and payload must agree.',
  );
const turn = z.object({
  id: z.string(),
  prompt: z.string(),
  status: z.enum(['running', 'completed', 'cancelled', 'failed']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  blocks: z.array(block),
  attachment: attachment.optional(),
  attachments: z.array(attachment).max(8).optional(),
  history: z
    .object({
      sessionId: z.string(),
      promptEntryId: z.string(),
      afterEntryId: z.string().nullable(),
    })
    .optional(),
  stream: streamMetrics.optional(),
});
const usage = z.object({
  used: z.number().finite().nonnegative(),
  size: z.number().finite().positive(),
  cost: z
    .object({ amount: z.number().finite().nonnegative(), currency: z.string().min(1) })
    .optional(),
  stale: z.boolean().optional(),
});
export const sessionTitle = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const session = z.object({
  id: z.string(),
  root: z.string(),
  label: z.string(),
  title: sessionTitle.optional(),
  archivedAt: z.number().finite().nonnegative().optional(),
  turns: z.array(turn),
  usage: usage.optional(),
  sessionFile: z
    .string()
    .regex(/^[\w.-]+\.jsonl$/)
    .optional(),
  historyTransition: z
    .object({
      before: historySnapshotSchema,
      entryId: z.string(),
      keepTurns: z.number().int().nonnegative(),
      archiveId: z.string(),
    })
    .optional(),
});
const hunkIdentity = z.object({ id: z.string(), signature: z.string() });
const change = z.object({
  id: z.string(),
  sessionId: z.string(),
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  state: z.enum(['applying', 'pending', 'conflict']),
  updatedAt: z.number(),
  destination: z.object({ path: z.string(), before: z.null(), after: z.string() }).optional(),
  intermediate: z.string().nullable().optional(),
  resolving: z.boolean().optional(),
  incomplete: z.boolean().optional(),
  hunkIds: z.array(hunkIdentity).optional(),
  hunkIntent: z
    .object({ before: z.string(), after: z.string(), hunkIds: z.array(hunkIdentity) })
    .optional(),
  operations: z
    .array(
      z.object({
        kind: z.enum(['create', 'edit', 'delete', 'rename']),
        at: z.number(),
        added: z.number().int().nonnegative().optional(),
        removed: z.number().int().nonnegative().optional(),
        turnId: z.string().optional(),
        toolCallId: z.string().optional(),
        tool: z.enum(['write', 'edit', 'rename', 'code_action', 'notebook_edit']).optional(),
      }),
    )
    .max(256)
    .optional(),
});
const state = z.object({
  version: z.literal(1),
  sessions: z.array(session),
  changes: z.array(change),
  activeSessionId: z.string().optional(),
  lastModel: z.string().max(300).optional(),
});
export type ChatBlock = z.infer<typeof block>;
export type Turn = z.infer<typeof turn>;
export type SavedSession = z.infer<typeof session>;
export type Attachment = z.infer<typeof attachment>;
export function bindTurnHistory(
  current: Turn,
  before: HistorySnapshot,
  after: HistorySnapshot,
): void {
  if (before.sessionId !== after.sessionId) return;
  const known = new Set(before.entries.map((entry) => entry.id));
  const added = after.entries.filter((entry) => entry.role === 'user' && !known.has(entry.id));
  if (added.length === 1)
    current.history = {
      sessionId: after.sessionId,
      promptEntryId: added[0]!.id,
      afterEntryId: after.leafId,
    };
}
export function cloneSession(
  source: SavedSession,
  id: string,
  snapshot: HistorySnapshot,
  count: number,
  label: string,
): SavedSession {
  const cloned: SavedSession = {
    ...structuredClone(source),
    id,
    label,
    title: undefined,
    archivedAt: undefined,
    sessionFile: snapshot.fileName,
    turns: structuredClone(source.turns.slice(0, count)),
    historyTransition: undefined,
  };
  const available = new Set(snapshot.entries.map((entry) => entry.id));
  for (const current of cloned.turns) {
    if (current.history && available.has(current.history.promptEntryId))
      current.history.sessionId = snapshot.sessionId;
    else delete current.history;
  }
  if (cloned.usage) cloned.usage.stale = true;
  return cloned;
}
function historyPrefix(
  before: HistorySnapshot['entries'],
  after: HistorySnapshot['entries'],
): boolean {
  return before.every((entry, index) => {
    const current = after[index];
    return (
      current?.id === entry.id &&
      current.parentId === entry.parentId &&
      current.type === entry.type &&
      current.role === entry.role
    );
  });
}
function historyBookkeeping(entries: HistorySnapshot['entries'], offset: number): boolean {
  return entries
    .slice(offset)
    .every(
      (entry, index) =>
        !entry.role &&
        ['custom', 'model_change', 'thinking_level_change'].includes(entry.type) &&
        entry.parentId === (entries[offset + index - 1]?.id ?? null),
    );
}

function verifyRetainedHistory(
  before: HistorySnapshot['entries'],
  after: HistorySnapshot['entries'],
  count: number,
) {
  const abandoned = new Set(before.slice(count).map((entry) => entry.id));
  if (
    !historyPrefix(before.slice(0, count), after) ||
    after.some((entry) => abandoned.has(entry.id)) ||
    !historyBookkeeping(after, count)
  )
    throw new Error(
      'History recovery is ambiguous. Select the archived session; files and reviews are unchanged.',
    );
}

export function reconcileHistory(
  session: SavedSession,
  snapshot: HistorySnapshot,
): 'unchanged' | 'rewound' {
  const transition = session.historyTransition;
  if (!transition || transition.before.sessionId !== snapshot.sessionId)
    throw new Error('Cannot reconcile this history transition. Select its archived session.');
  const before = transition.before.entries.map((entry) => entry.id);
  const target = transition.before.entries.findIndex((entry) => entry.id === transition.entryId);
  if (target < 0 || transition.keepTurns > session.turns.length)
    throw new Error('Invalid saved history boundary. Select its archived session.');
  if (
    historyPrefix(transition.before.entries, snapshot.entries) &&
    historyBookkeeping(snapshot.entries, before.length)
  ) {
    delete session.historyTransition;
    return 'unchanged';
  }
  const retained = before.slice(
    0,
    target + (transition.before.entries[target]!.role === 'user' ? 0 : 1),
  );
  verifyRetainedHistory(transition.before.entries, snapshot.entries, retained.length);
  session.turns.splice(transition.keepTurns);
  if (session.usage) session.usage.stale = true;
  delete session.historyTransition;
  return 'rewound';
}

export function parseUsage(update: {
  used: number;
  size: number;
  cost?: unknown;
}): z.infer<typeof usage> | undefined {
  const parsed = usage.safeParse({ ...update, cost: update.cost ?? undefined });
  return parsed.success ? parsed.data : undefined;
}

export function appendChunk(
  current: Turn,
  kind: 'text' | 'thought',
  text: string,
  messageId?: string,
  metadata: Pick<ChatBlock, 'receivedAt' | 'model'> = {},
): void {
  const last = current.blocks.at(-1);
  const id = messageId ? `${kind}:${messageId}` : undefined;
  let chunk = id
    ? current.blocks.find((candidate) => candidate.id === id)
    : last?.kind === kind
      ? last
      : undefined;
  if (!chunk) {
    chunk = {
      id: id ?? `${kind}:${randomUUID()}`,
      kind,
      text: '',
      ...metadata,
      receivedAt: metadata.receivedAt ?? Date.now(),
    };
    current.blocks.push(chunk);
  }
  chunk.text = (chunk.text + text).slice(0, 256_000);
  recordChunkMetrics(current, kind, text, metadata.receivedAt);
}
export const webviewMessage = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(1),
      type: z.literal('approval'),
      id: z.string().uuid(),
      decision: z.enum(['allow', 'skip']),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('approvalSettings'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('permissions'),
      mode: permissionMode,
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('permissionSettings') }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('pasteImages'),
      images: z.array(imageSchema).min(1).max(8),
    })
    .strict(),
  z.object({
    v: z.literal(1),
    type: z.enum([
      'ready',
      'connect',
      'disconnect',
      'new',
      'sessions',
      'cancel',
      'attach',
      'attachContext',
      'output',
      'openFolder',
      'compact',
      'inspectContext',
      'terminals',
      'clearQueue',
      'resumeQueue',
      'keepAll',
      'discardAll',
      'openInBrowser',
    ]),
  }),
  z.object({
    v: z.literal(1),
    type: z.enum(['prompt', 'queuePrompt']),
    text: z.string().trim().min(1).max(128_000),
  }),
  z
    .object({
      v: z.literal(1),
      type: z.literal('editPrompt'),
      id: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(128_000),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('forkTurn'),
      id: z.string().min(1).max(100),
      boundary: z.enum(['before', 'after']),
    })
    .strict(),
  z.object({
    v: z.literal(1),
    type: z.enum([
      'review',
      'keep',
      'discard',
      'copyTool',
      'inspectAttachment',
      'removeAttachment',
      'attachOffer',
      'dismissOffer',
      'removeQueued',
      'openSession',
      'resumeSession',
      'archiveSession',
      'restoreSession',
    ]),
    id: z.string().min(1).max(100),
  }),
  z
    .object({
      v: z.literal(1),
      type: z.enum(['hunkReview', 'hunkKeep', 'hunkDiscard']),
      id: z.string().min(1).max(100),
      hunkId: z.string().min(1).max(100),
    })
    .strict(),
  z.object({
    v: z.literal(1),
    type: z.literal('config'),
    id: z.enum(['model', 'thinking']),
    value: z.string().min(1).max(300),
  }),
  z.object({ v: z.literal(1), type: z.literal('modelCatalog') }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('modelRoute'),
      value: z.union([z.literal('auto'), z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)]),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('questionAnswer'),
      id: z.string().min(1).max(100),
      answers: questionAnswers,
    })
    .strict(),
  z
    .object({ v: z.literal(1), type: z.literal('questionCancel'), id: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('renameSession'),
      id: z.string().min(1).max(100),
      title: sessionTitle,
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('refreshSessions') }).strict(),
  z.object({ v: z.literal(1), type: z.literal('focus'), focused: z.boolean() }).strict(),
  z.object({ v: z.literal(1), type: z.literal('link'), href: z.string().max(4096) }),
]);

export class StateStore {
  data: z.infer<typeof state> = { version: 1, sessions: [], changes: [] };
  private queue: Promise<void> = Promise.resolve();
  private persistedBytes = 0;

  constructor(
    readonly directory: string,
    private readonly maximumBytes: number = retentionPolicy.maximumStateBytes,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const source = await readFile(path.join(this.directory, 'state.json'), 'utf8');
      this.data = state.parse(JSON.parse(source));
      this.persistedBytes = Buffer.byteLength(source);
      for (const saved of this.data.sessions) {
        for (const current of saved.turns)
          if (current.status === 'running') current.status = 'cancelled';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'OMP state could not be loaded. Existing review snapshots have not been overwritten.',
          { cause: error },
        );
    }
  }

  save(): Promise<void> {
    return this.enqueue(() => this.persist());
  }

  updateSessions(update: (data: StateStore['data']) => SavedSession[]): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.data.sessions;
      const previousOwner = this.data.activeSessionId;
      this.data.sessions = update(this.data);
      try {
        await this.persist();
      } catch (error) {
        this.data.sessions = previous;
        this.data.activeSessionId = previousOwner;
        throw error;
      }
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const bytes = Buffer.byteLength(snapshot);
    if (bytes > this.maximumBytes && bytes > this.persistedBytes)
      throw new Error(
        'OMP state exceeds its storage budget. Export or remove inactive sessions before continuing.',
      );
    const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'state.json'));
      this.persistedBytes = bytes;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
