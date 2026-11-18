import assert from 'node:assert/strict';
import test from 'node:test';
import type { Change } from '../review.js';
import { hunkIdentities, resolveHunk, reviewHunks } from '../review-hunks.js';

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
