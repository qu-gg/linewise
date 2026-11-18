import { diffLines } from 'diff';
import type { Change } from './review.js';
import path from 'node:path';
import { reviewHunks } from './review-hunks.js';
import { changeKind } from './review-types.js';

export function reviewImages(change: Change) {
  return [
    { path: `/${change.id}/before/${path.basename(change.path)}`, text: change.before ?? '' },
    {
      path: `/${change.id}/after/${path.basename(change.destination?.path ?? change.path)}`,
      text: change.destination?.after ?? change.after ?? '',
    },
  ];
}

export function reviewSummary(
  change: Change,
  relative: (target: string) => string,
  turns: readonly { id: string }[] = [],
) {
  const source = relative(change.path);
  const name = change.destination
    ? `${source} -> ${relative(change.destination.path)}`
    : change.after === null
      ? `${source} (Deleted)`
      : source;
  const parts = diffLines(change.before ?? '', change.destination?.after ?? change.after ?? '');
  return {
    id: change.id,
    name,
    state: change.state,
    kind: changeKind(change.before, change.after, Boolean(change.destination)),
    operations: (change.operations ?? []).map((operation) => {
      const index = turns.findIndex((turn) => turn.id === operation.turnId);
      return { ...operation, turn: index < 0 ? undefined : index + 1 };
    }),
    hunks: reviewHunks(change).map(({ id, oldStart, newStart, oldLines, newLines }) => ({
      id,
      oldStart,
      newStart,
      oldLines,
      newLines,
    })),
    added: parts.filter((part) => part.added).reduce((sum, part) => sum + (part.count ?? 0), 0),
    removed: parts.filter((part) => part.removed).reduce((sum, part) => sum + (part.count ?? 0), 0),
  };
}
