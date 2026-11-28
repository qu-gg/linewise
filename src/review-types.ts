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
