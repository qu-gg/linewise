import { diffLines } from 'diff';

export type Approval = (
  operation: {
    kind: 'read' | 'write' | 'delete' | 'move';
    path: string;
    before?: string | null;
    after?: string | null;
    destination?: string;
  },
  signal?: AbortSignal,
) => Promise<boolean>;

export interface Provenance {
  turnId?: string;
  toolCallId?: string;
  tool?: 'write' | 'edit' | 'rename' | 'code_action' | 'notebook_edit';
}

export interface ReviewOperation extends Provenance {
  kind: 'create' | 'edit' | 'delete' | 'rename';
  at: number;
  added?: number;
  removed?: number;
}

export interface Change {
  id: string;
  sessionId: string;
  path: string;
  before: string | null;
  after: string | null;
  applied?: string | null;
  suggestion?: string | null;
  state: 'applying' | 'pending' | 'conflict';
  updatedAt: number;
  destination?: { path: string; before: null; after: string };
  intermediate?: string | null;
  resolving?: boolean;
  incomplete?: boolean;
  hunkIds?: { id: string; signature: string }[];
  hunkIntent?: { before: string; after: string; hunkIds: { id: string; signature: string }[] };
  operations?: ReviewOperation[];
}

export function appliedText(change: Change): string | null {
  if (change.destination) return change.destination.after;
  return change.applied !== undefined ? change.applied : change.after;
}

export function suggestionText(change: Change): string | null {
  if (change.destination) return change.destination.after;
  return change.suggestion !== undefined ? change.suggestion : appliedText(change);
}

export function editedProposal(change: Change): boolean {
  return !change.destination && change.after !== null && change.after !== appliedText(change);
}

export function editableProposal(change: Change): boolean {
  return change.state === 'pending' && !change.destination && change.after !== null;
}

export function images(change: Change): Pick<Change, 'path' | 'before' | 'after'>[] {
  return change.destination ? [change.destination, change] : [change];
}

export function changeKind(
  before: string | null,
  after: string | null,
  moving = false,
): ReviewOperation['kind'] {
  if (moving) return 'rename';
  if (before === null) return 'create';
  return after === null ? 'delete' : 'edit';
}

export function lineStats(before: string | null, after: string | null) {
  const parts = diffLines(before ?? '', after ?? '');
  return {
    added: parts.filter((part) => part.added).reduce((sum, part) => sum + (part.count ?? 0), 0),
    removed: parts.filter((part) => part.removed).reduce((sum, part) => sum + (part.count ?? 0), 0),
  };
}

export function operationHistory(
  prior: Change | undefined,
  before: string | null,
  after: string | null,
  provenance?: Provenance,
  moving = false,
): ReviewOperation[] {
  return [
    ...(prior?.operations ?? []),
    {
      ...provenance,
      kind: changeKind(before, after, moving),
      at: Date.now(),
      ...lineStats(before, after),
    },
  ].slice(-256);
}

export type PriorAction = 'reuse' | 'drop' | 'conflict';

export function reconcilePrior(prior: Change, previous: string | null): PriorAction {
  if (prior.after === previous) return 'reuse';
  if (previous === prior.before) return 'drop';
  return 'conflict';
}

function findPrior(changes: Change[], sessionId: string, target: string): Change | undefined {
  return changes.find(
    (change) =>
      images(change).some((image) => image.path === target) && change.sessionId === sessionId,
  );
}

function assertPrior(
  changes: Change[],
  prior: Change | undefined,
  sessionId: string,
  target: string,
): void {
  if (prior?.destination) throw new Error('Resolve the paired move before editing either path.');
  if (
    changes.some(
      (change) =>
        images(change).some((image) => image.path === target) && change.sessionId !== sessionId,
    )
  ) {
    throw new Error(
      'Resolve this file in its owning session before editing it from another session.',
    );
  }
  if (prior?.hunkIntent) throw new Error('Recover the interrupted hunk operation before editing.');
}

async function dropPrior(
  changes: Change[],
  prior: Change,
  persist: (changes: readonly Change[]) => Promise<void>,
): Promise<void> {
  const index = changes.findIndex((change) => change.id === prior.id);
  if (index >= 0) changes.splice(index, 1);
  await persist(changes);
}

async function conflictPrior(
  prior: Change,
  persist: (changes: readonly Change[]) => Promise<void>,
): Promise<never> {
  prior.state = 'conflict';
  await persist([prior]);
  throw new Error('File has newer changes; resolve its pending review first.');
}

async function reusePrior(
  prior: Change,
  persist: (changes: readonly Change[]) => Promise<void>,
): Promise<Change> {
  if (prior.state === 'conflict') {
    prior.state = 'pending';
    await persist([prior]);
  }
  return prior;
}

export async function priorChange(
  changes: Change[],
  sessionId: string,
  target: string,
  previous: string | null,
  persist: (changes: readonly Change[]) => Promise<void>,
): Promise<Change | undefined> {
  const prior = findPrior(changes, sessionId, target);
  assertPrior(changes, prior, sessionId, target);
  if (!prior) return undefined;
  const action = reconcilePrior(prior, previous);
  if (action === 'drop') {
    await dropPrior(changes, prior, persist);
    return undefined;
  }
  if (action === 'conflict') await conflictPrior(prior, persist);
  return reusePrior(prior, persist);
}
