import assert from 'node:assert/strict';
import test from 'node:test';
import type { Change } from '../review.js';
import { hunkIdentities, resolveHunk, reviewHunks } from '../review-hunks.js';
import { inlineReview, reviewSummary } from '../review-presentation.js';

test('identical hunks retain separate identities after resolution and stale controls cannot select another hunk', () => {
  const before = Array.from({ length: 32 }, () => 'context\n').join('');
  const after = before
    .split('\n')
    .map((line, index) => ([6, 24].includes(index) ? 'changed' : line))
    .join('\n');
  const change: Change = {
    id: 'duplicates',
    sessionId: 'owner',
    path: '/test.txt',
    before,
    after,
    state: 'pending',
    updatedAt: 1,
  };
  change.hunkIds = hunkIdentities(change);
  const [first, second] = reviewHunks(change);
  assert.ok(first && second);
  assert.equal(first.signature, second.signature);
  const resolved = { ...change, ...resolveHunk(change, first.id, 'keep') };
  assert.equal(reviewHunks(resolved)[0]!.id, second.id);
  assert.throws(() => resolveHunk(resolved, first.id, 'keep'), /stale/);
});

test('hunk resolution preserves CRLF and independent identities while advancing only accepted baselines', () => {
  const before = Array.from({ length: 16 }, (_, index) => `line ${index}\r\n`).join('');
  const after = before.replace('line 0', 'accepted\r\ninserted').replace('line 15', 'pending');
  const change: Change = {
    id: 'change',
    sessionId: 'owner',
    path: '/test.txt',
    before,
    after,
    state: 'pending',
    updatedAt: 1,
  };
  const [first, second] = reviewHunks(change);
  assert.ok(first && second);
  const kept = { ...change, ...resolveHunk(change, first.id, 'keep') };
  assert.equal(kept.before, before.replace('line 0', 'accepted\r\ninserted'));
  assert.equal(kept.after, after);
  assert.equal(reviewHunks(kept)[0]!.id, second.id);
  const discarded = resolveHunk(kept, second.id, 'discard');
  assert.equal(discarded.after, kept.before);
  assert.equal(reviewHunks({ ...kept, ...discarded }).length, 0);
  assert.throws(() => resolveHunk(kept, first.id, 'discard'), /stale/);
  assert.deepEqual(reviewHunks({ ...change, state: 'conflict' }), []);
  assert.deepEqual(reviewHunks({ ...change, before: null }), []);
  assert.deepEqual(reviewHunks({ ...change, after: null }), []);
});

test('inline hunk previews use immutable journal text and retain exact identities with bounded payloads', () => {
  const change: Change = {
    id: 'preview',
    sessionId: 'owner',
    path: '/test.txt',
    before: 'original\r\ncontext\r\n',
    after: '<script>changed</script>\r\ncontext\r\n',
    state: 'pending',
    updatedAt: 1,
  };
  const original = structuredClone(change);
  const expected = reviewHunks(change)[0]!;
  const presented = reviewSummary(change, (target) => target).hunks[0]!;
  assert.equal(presented.id, expected.id);
  assert.deepEqual(presented.preview, expected.lines);
  assert.equal(presented.truncated, false);
  assert.deepEqual(change, original);
  const large = reviewSummary(
    { ...change, before: 'before\n'.repeat(300), after: 'after\n'.repeat(300) },
    (target) => target,
  );
  assert.equal(large.hunks[0]!.preview.length, 200);
  assert.equal(large.hunks[0]!.truncated, true);
  const wide = reviewSummary({ ...change, after: 'x'.repeat(24_001) }, (target) => target);
  assert.ok(wide.hunks.flatMap((hunk) => hunk.preview).join('').length <= 24_000);
  assert.equal(wide.hunks[0]!.truncated, true);
});

test('full-file inline review preserves Header/Footer identities and clears only resolved changes', () => {
  const before = `Header:\r\n${'context\r\n'.repeat(12)}Footer:\r\n`;
  const change: Change = {
    id: 'inline',
    sessionId: 'owner',
    path: '/review.ts',
    before,
    after: before.replace('Header:', 'HEADER:').replace('Footer:', 'FOOTER:'),
    state: 'pending',
    updatedAt: 1,
  };
  change.hunkIds = hunkIdentities(change);
  const original = structuredClone(change);
  const model = inlineReview(change);
  assert.equal(model.text, change.after);
  assert.deepEqual(
    model.parts.map((part) => [part.kind, part.line, part.originalLine, part.text]),
    [
      ['removed', 1, 1, 'Header:\r\n'],
      ['added', 1, 2, 'HEADER:\r\n'],
      ['removed', 14, 14, 'Footer:\r\n'],
      ['added', 14, 15, 'FOOTER:\r\n'],
    ],
  );
  assert.equal(model.hunks.length, 2);
  assert.ok(model.parts.every((part) => model.hunks.some((hunk) => hunk.id === part.hunkId)));
  const kept = { ...change, ...resolveHunk(change, model.hunks[0]!.id, 'keep') };
  const remaining = inlineReview(kept);
  assert.equal(remaining.text, model.text);
  assert.deepEqual(remaining.hunks, [model.hunks[1]]);
  assert.deepEqual(
    remaining.parts.map((part) => part.text),
    ['Footer:\r\n', 'FOOTER:\r\n'],
  );
  const restored = { ...kept, ...resolveHunk(kept, remaining.hunks[0]!.id, 'discard') };
  assert.equal(inlineReview(restored).text, before.replace('Header:', 'HEADER:'));
  assert.deepEqual(inlineReview(restored).parts, []);
  assert.deepEqual(inlineReview(restored).hunks, []);
  assert.deepEqual(change, original);
});
