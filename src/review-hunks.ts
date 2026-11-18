import { createHash, randomUUID } from 'node:crypto';
import { applyPatch, reversePatch, structuredPatch } from 'diff';
import type { Change } from './review-types.js';

function patchFor(change: Change) {
  if (
    change.state !== 'pending' ||
    change.destination ||
    change.before === null ||
    change.after === null
  )
    return;
  return structuredPatch('before', 'after', change.before, change.after, '', '', { context: 3 });
}

export function reviewHunks(change: Change) {
  const occurrences = new Map<string, number>();
  return (patchFor(change)?.hunks ?? []).map((patch, index) => {
    const signature = createHash('sha256').update(JSON.stringify(patch.lines)).digest('hex');
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return {
      id:
        change.hunkIds?.[index]?.signature === signature
          ? change.hunkIds[index]!.id
          : `${signature}-${occurrence}`,
      signature,
      oldStart: patch.oldStart,
      newStart: patch.newStart,
      oldLines: patch.oldLines,
      newLines: patch.newLines,
      lines: patch.lines,
    };
  });
}

function identityGroups(hunks: { id: string; signature: string }[]) {
  const groups = new Map<string, { id: string; signature: string }[]>();
  for (const hunk of hunks) {
    const group = groups.get(hunk.signature) ?? [];
    group.push(hunk);
    groups.set(hunk.signature, group);
  }
  return groups;
}

export function hunkIdentities(change: Change, previous: ReturnType<typeof reviewHunks> = []) {
  const hunks = reviewHunks({ ...change, state: 'pending', hunkIds: undefined });
  const available = identityGroups(previous);
  const current = identityGroups(hunks);
  for (const [signature, candidates] of available)
    if (candidates.length !== current.get(signature)?.length) available.delete(signature);
  return hunks.map(({ signature }) => ({
    signature,
    id: available.get(signature)?.shift()?.id ?? randomUUID(),
  }));
}

export function resolveHunk(change: Change, id: string, action: 'keep' | 'discard') {
  const patch = patchFor(change);
  const index = reviewHunks(change).findIndex((hunk) => hunk.id === id);
  if (!patch || index < 0) throw new Error('Unknown, stale or unavailable review hunk.');
  const selected = { ...patch, hunks: [patch.hunks[index]!] };
  const source = action === 'keep' ? change.before! : change.after!;
  const result = applyPatch(source, action === 'keep' ? selected : reversePatch(selected), {
    fuzzFactor: 0,
    autoConvertLineEndings: false,
  });
  if (result === false) throw new Error('Review hunk context no longer matches.');
  const resolved =
    action === 'keep'
      ? { before: result, after: change.after! }
      : { before: change.before!, after: result };
  return {
    ...resolved,
    hunkIds: hunkIdentities(
      { ...change, ...resolved },
      reviewHunks(change).filter((hunk) => hunk.id !== id),
    ),
  };
}
