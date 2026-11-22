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

export function inlineReview(change: Change) {
  const text = change.destination?.after ?? change.after ?? '';
  const hunks = reviewHunks(change);
  let oldLine = 1;
  let newLine = 1;
  const parts = diffLines(change.before ?? '', text).flatMap((part) => {
    const line = newLine;
    const originalLine = oldLine;
    const count = part.count ?? 0;
    if (!part.added) oldLine += count;
    if (!part.removed) newLine += count;
    if (!part.added && !part.removed) return [];
    const hunk = hunks.find((candidate) => {
      const start = part.removed ? candidate.oldStart : candidate.newStart;
      const length = part.removed ? candidate.oldLines : candidate.newLines;
      const position = part.removed ? originalLine : line;
      return position >= start && position < start + length;
    });
    return [
      {
        kind: part.removed ? ('removed' as const) : ('added' as const),
        line,
        originalLine,
        count,
        text: part.value,
        hunkId: hunk?.id,
      },
    ];
  });
  return {
    text,
    parts,
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      line: parts.find((part) => part.hunkId === hunk.id)?.line ?? hunk.newStart,
    })),
  };
}

function presentedHunks(change: Change) {
  let remainingLines = 200;
  let remainingCharacters = 24_000;
  return reviewHunks(change).map(({ id, oldStart, newStart, oldLines, newLines, lines }) => {
    const preview: string[] = [];
    for (const line of lines) {
      if (remainingLines === 0 || line.length > remainingCharacters) break;
      preview.push(line);
      remainingLines--;
      remainingCharacters -= line.length;
    }
    return {
      id,
      oldStart,
      newStart,
      oldLines,
      newLines,
      preview,
      truncated: preview.length < lines.length,
    };
  });
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
    hunks: presentedHunks(change),
    added: parts.filter((part) => part.added).reduce((sum, part) => sum + (part.count ?? 0), 0),
    removed: parts.filter((part) => part.removed).reduce((sum, part) => sum + (part.count ?? 0), 0),
  };
}
