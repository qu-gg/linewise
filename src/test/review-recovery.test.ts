import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, ReviewJournal } from '../review.js';
import type { Change, TextFiles } from '../review.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-review-'));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const data = new Map<string, string>();
  const files: TextFiles = {
    read: async (target) => data.get(target) ?? null,
    replace: async (target, expected, content) => {
      assert.equal(data.get(target) ?? null, expected);
      if (content === null) data.delete(target);
      else data.set(target, content);
    },
  };
  const journal = new ReviewJournal(
    files,
    new PathGuard([root]),
    async () => true,
    async () => {},
    [] as Change[],
  );
  return {
    root,
    data,
    journal,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('an external revert to the review baseline supersedes the stale pending change', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'reverted.txt');
    current.data.set(target, 'baseline');
    await current.journal.write('session', target, 'agent');
    current.data.set(target, 'baseline');
    await current.journal.write('session', target, 'retry');
    const changes = current.journal.list();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.before, 'baseline');
    assert.equal(changes[0]!.after, 'retry');
    assert.equal(changes[0]!.state, 'pending');
  } finally {
    await current.cleanup();
  }
});

test('a conflicted review clears when disk returns to the pending postimage', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'recovered.txt');
    current.data.set(target, 'baseline');
    await current.journal.write('session', target, 'agent');
    current.data.set(target, 'external');
    await assert.rejects(current.journal.write('session', target, 'lost'), /newer changes/);
    assert.equal(current.journal.list()[0]!.state, 'conflict');
    current.data.set(target, 'agent');
    await current.journal.write('session', target, 'next');
    const change = current.journal.list()[0]!;
    assert.equal(change.before, 'baseline');
    assert.equal(change.after, 'next');
    assert.equal(change.state, 'pending');
  } finally {
    await current.cleanup();
  }
});

test('discarding a review whose content is already at the baseline is a no-op', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'already-reverted.txt');
    current.data.set(target, 'baseline');
    await current.journal.write('session', target, 'agent');
    const id = current.journal.list()[0]!.id;
    current.data.set(target, 'baseline');
    await current.journal.discard(id);
    assert.deepEqual(current.journal.list(), []);
  } finally {
    await current.cleanup();
  }
});
