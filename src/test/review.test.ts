import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PathGuard, ReviewJournal } from '../review.js';
import type { Change, TextFiles } from '../review.js';
import { resolveHunk, reviewHunks } from '../review-hunks.js';

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
  let saved: readonly Change[] = [];
  let approvals = 0;
  let allowed = false;
  const journal = new ReviewJournal(
    files,
    new PathGuard([root]),
    async () => {
      approvals++;
      return allowed;
    },
    async (changes) => {
      saved = structuredClone(changes);
    },
  );
  return {
    directory,
    root,
    data,
    files,
    journal,
    saved: () => saved,
    approvals: () => approvals,
    allow: () => {
      allowed = true;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('journal hunk operations preserve accepted baselines across later writes and refuse external edits', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'hunks.txt');
  const before = Array.from({ length: 16 }, (_, index) => `line ${index}\r\n`).join('');
  current.data.set(target, before);
  await current.journal.write(
    'session',
    target,
    before.replace('line 0', 'kept').replace('line 15', 'pending'),
  );
  const change = current.journal.list()[0]!;
  const [first, second] = reviewHunks(change);
  await current.journal.resolveHunk(change.id, first!.id, 'keep');
  await current.journal.resolveHunk(change.id, second!.id, 'discard');
  assert.equal(current.data.get(target), before.replace('line 0', 'kept'));
  assert.deepEqual(current.journal.list(), []);
  await current.journal.write('session', target, before.replace('line 0', 'new edit'));
  assert.equal(current.journal.list()[0]!.before, before.replace('line 0', 'kept'));
  current.data.set(target, 'new user work');
  const pending = current.journal.list()[0]!;
  await assert.rejects(
    current.journal.resolveHunk(pending.id, reviewHunks(pending)[0]!.id, 'discard'),
    /newer user/,
  );
  assert.equal(current.data.get(target), 'new user work');
  assert.equal(current.journal.list()[0]!.state, 'conflict');
});

test('interrupted hunk intent recovers both unapplied and applied writes without losing remaining changes', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'recover-hunk.txt');
  const before = Array.from({ length: 16 }, (_, index) => `line ${index}\n`).join('');
  const after = before.replace('line 0', 'first').replace('line 15', 'second');
  const original: Change = {
    id: 'hunks',
    sessionId: 'owner',
    path: target,
    before,
    after,
    state: 'pending',
    updatedAt: 1,
  };
  const hunkIntent = resolveHunk(original, reviewHunks(original)[0]!.id, 'discard');
  for (const applied of [false, true]) {
    current.data.set(target, applied ? hunkIntent.after : after);
    const journal = new ReviewJournal(
      current.files,
      new PathGuard([current.root]),
      async () => false,
      async () => {},
      [{ ...original, state: 'applying', hunkIntent }],
    );
    await journal.refresh();
    assert.equal(journal.list()[0]!.state, 'pending');
    assert.equal(journal.list()[0]!.hunkIntent, undefined);
    assert.equal(reviewHunks(journal.list()[0]!).length, applied ? 1 : 2);
    await journal.discard('hunks');
    assert.equal(current.data.get(target), before);
  }
});

test('explicit deletes preserve the cumulative baseline, restore on Discard and persist for restart', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'delete.txt');
    current.data.set(target, 'user baseline');
    await current.journal.write('session', target, 'agent edit');
    await current.journal.delete('session', target);
    assert.equal(current.data.has(target), false);
    assert.equal(current.saved()[0]!.after, null);
    const recovered = new ReviewJournal(
      current.files,
      new PathGuard([current.root]),
      async () => false,
      async () => {},
      current.saved(),
    );
    await recovered.refresh();
    assert.equal(recovered.list()[0]!.before, 'user baseline');
    await recovered.discard(recovered.list()[0]!.id);
    assert.equal(current.data.get(target), 'user baseline');
    await assert.rejects(
      current.journal.delete('session', path.join(current.root, 'missing.txt')),
      /missing file/,
    );
  } finally {
    await current.cleanup();
  }
});

test('delete denial and cancellation are no-ops, and Keep accepts only the recorded removal', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.directory, 'outside.txt');
    current.data.set(target, 'private');
    await assert.rejects(current.journal.delete('session', target), /not approved/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(current.journal.delete('session', target, abort.signal));
    assert.equal(current.data.get(target), 'private');
    assert.deepEqual(current.journal.list(), []);
    current.allow();
    await current.journal.delete('session', target);
    await current.journal.keep(current.journal.list()[0]!.id);
    assert.equal(current.data.has(target), false);
    assert.deepEqual(current.journal.list(), []);
  } finally {
    await current.cleanup();
  }
});

test('successive turns accumulate against the first user buffer and discard preserves it', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'test.txt');
    current.data.set(target, 'pre-existing user changes\n');
    await current.journal.write('session', target, 'first agent turn\n');
    await current.journal.write('session', target, 'second agent turn\n');
    const [change] = current.journal.list();
    assert.ok(change);
    assert.equal(change.before, 'pre-existing user changes\n');
    assert.equal(change.after, 'second agent turn\n');
    assert.equal(current.approvals(), 0);
    await current.journal.discard(change.id);
    assert.equal(current.data.get(target), 'pre-existing user changes\n');
    assert.equal(current.journal.list().length, 0);
  } finally {
    await current.cleanup();
  }
});

test('Keep retains disk content and establishes a new baseline', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'new.txt');
    await current.journal.write('session', target, 'accepted');
    await current.journal.keep(current.journal.list()[0]!.id);
    assert.equal(current.data.get(target), 'accepted');
    await current.journal.write('session', target, 'pending');
    assert.equal(current.journal.list()[0]!.before, 'accepted');
  } finally {
    await current.cleanup();
  }
});

test('rejected outside reads and writes leave targets and journal unchanged', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.directory, 'sensitive.txt');
    current.data.set(target, 'private');
    await assert.rejects(current.journal.read(target), /not approved/);
    await assert.rejects(current.journal.write('session', target, 'changed'), /not approved/);
    assert.equal(current.data.get(target), 'private');
    assert.deepEqual(current.journal.list(), []);
    current.allow();
    await current.journal.write('session', target, 'approved once');
    await current.journal.write('session', target, 'requires approval again');
    assert.equal(current.approvals(), 4);
    assert.equal(current.saved()[0]!.before, 'private');
  } finally {
    await current.cleanup();
  }
});

test('newer user edits cannot be overwritten by discard or another agent write', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'test.txt');
    await current.journal.write('session', target, 'agent');
    current.data.set(target, 'newer user work');
    await assert.rejects(current.journal.discard(current.journal.list()[0]!.id), /newer user/);
    await assert.rejects(current.journal.write('session', target, 'overwrite'), /newer changes/);
    assert.equal(current.data.get(target), 'newer user work');
    assert.equal(current.journal.list()[0]!.state, 'conflict');
  } finally {
    await current.cleanup();
  }
});

test('discarding an agent-created file deletes only that recorded file', async () => {
  const current = await fixture();
  try {
    const target = path.join(current.root, 'created.txt');
    await current.journal.write('session', target, 'new');
    await current.journal.discard(current.journal.list()[0]!.id);
    assert.equal(current.data.has(target), false);
  } finally {
    await current.cleanup();
  }
});

test('symlink escapes require approval and traversal paths fail closed', async () => {
  const current = await fixture();
  try {
    await symlink(current.directory, path.join(current.root, 'escape'));
    const guard = new PathGuard([current.root]);
    assert.equal(
      (await guard.resolve(path.join(current.root, 'escape', 'private.txt'))).inside,
      false,
    );
    await assert.rejects(guard.resolve(`${current.root}/../private.txt`), /traversal/);
    await assert.rejects(guard.resolve('relative.txt'), /absolute/);
    await assert.rejects(
      current.journal.write('session', path.join(current.root, 'escape', 'private.txt'), 'no'),
      /not approved/,
    );
  } finally {
    await current.cleanup();
  }
});

test('a symlink retargeted while approval is pending cannot change the approved target', async () => {
  const current = await fixture();
  try {
    const first = path.join(current.directory, 'first.txt');
    const second = path.join(current.directory, 'second.txt');
    const link = path.join(current.root, 'link.txt');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await symlink(first, link);
    const journal = new ReviewJournal(
      current.files,
      new PathGuard([current.root]),
      async () => {
        await unlink(link);
        await symlink(second, link);
        return true;
      },
      async () => {},
    );
    await assert.rejects(journal.write('session', link, 'changed'), /Target path changed/);
    assert.deepEqual(journal.list(), []);
  } finally {
    await current.cleanup();
  }
});

test('cancellation while outside approval is pending prevents a late approved write', async () => {
  const current = await fixture();
  try {
    const signal = new AbortController();
    const journal = new ReviewJournal(
      current.files,
      new PathGuard([current.root]),
      async () => {
        signal.abort();
        return true;
      },
      async () => {},
    );
    const target = path.join(current.directory, 'cancelled.txt');
    await assert.rejects(journal.write('session', target, 'no', signal.signal), /abort/i);
    assert.equal(current.data.has(target), false);
    assert.deepEqual(journal.list(), []);
  } finally {
    await current.cleanup();
  }
});

test('dangling symlinks fail closed instead of being mistaken for new in-workspace files', async () => {
  const current = await fixture();
  try {
    const link = path.join(current.root, 'dangling.txt');
    await symlink(path.join(current.directory, 'missing.txt'), link);
    await assert.rejects(new PathGuard([current.root]).resolve(link), /dangling symbolic link/);
  } finally {
    await current.cleanup();
  }
});

test('no-op writes resolve their record and another session cannot take pending ownership', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'owned.txt');
  current.data.set(target, 'baseline');
  await current.journal.write('owner', target, 'pending');
  await assert.rejects(current.journal.write('other', target, 'stolen'), /owning session/);
  assert.equal(current.data.get(target), 'pending');
  await current.journal.write('owner', target, 'baseline');
  assert.deepEqual(current.journal.list(), []);
  assert.equal(current.data.get(target), 'baseline');
  await assert.rejects(current.journal.keep('unknown'), /already resolved/);
});

test('rejected binary and oversized writes leave the queue usable and never replace content', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'text.txt');
  for (const content of ['binary\0text', 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(current.journal.write('session', target, content), /Binary or oversized/);
  }
  assert.deepEqual(current.journal.list(), []);
  await current.journal.write('session', target, 'valid');
  assert.equal(await current.journal.read(target), 'valid');
  await assert.rejects(
    current.journal.read(path.join(current.root, 'missing.txt')),
    /does not exist/,
  );
});

test('approval cannot overwrite content edited while the prompt was pending', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.directory, 'outside.txt');
  current.data.set(target, 'before');
  const journal = new ReviewJournal(
    current.files,
    new PathGuard([current.root]),
    async () => {
      current.data.set(target, 'user edit');
      return true;
    },
    async () => {},
  );
  await assert.rejects(journal.write('session', target, 'agent edit'), /approval was pending/);
  assert.equal(current.data.get(target), 'user edit');
  assert.deepEqual(journal.list(), []);
});

test('cancel after durable intent prevents a write and recovery removes the unapplied intent', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const controller = new AbortController();
  const journal = new ReviewJournal(
    current.files,
    new PathGuard([current.root]),
    async () => true,
    async () => controller.abort(),
  );
  const target = path.join(current.root, 'cancelled.txt');
  await assert.rejects(journal.write('session', target, 'agent', controller.signal), /abort/i);
  assert.equal(current.data.has(target), false);
  assert.equal(journal.list()[0]!.state, 'applying');
  await journal.refresh();
  assert.deepEqual(journal.list(), []);
});

test('recovery distinguishes unapplied intent, applied intent, conflicts and unreadable files', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const entries: Change[] = ['unapplied', 'applied', 'changed', 'sticky', 'unreadable'].map(
    (id) => ({
      id,
      sessionId: 'owner',
      path: path.join(current.root, id),
      before: 'before',
      after: 'after',
      state: id === 'sticky' ? 'conflict' : 'applying',
      updatedAt: 1,
    }),
  );
  current.data.set(entries[0]!.path, 'before');
  current.data.set(entries[1]!.path, 'after');
  current.data.set(entries[2]!.path, 'new user content');
  current.data.set(entries[3]!.path, 'after');
  let persists = 0;
  const files: TextFiles = {
    ...current.files,
    read: async (target) => {
      if (target.endsWith('unreadable')) throw new Error('Permission denied');
      return current.files.read(target);
    },
  };
  const journal = new ReviewJournal(
    files,
    new PathGuard([current.root]),
    async () => false,
    async () => {
      persists++;
    },
    entries,
  );
  await journal.refresh();
  assert.deepEqual(
    journal.list().map(({ id, state }) => [id, state]),
    [
      ['applied', 'pending'],
      ['changed', 'conflict'],
      ['sticky', 'conflict'],
      ['unreadable', 'conflict'],
    ],
  );
  await journal.refresh();
  assert.equal(persists, 1);
  assert.equal(entries[0]!.state, 'applying');
  assert.equal(current.data.get(entries[2]!.path), 'new user content');
});

test('save-participant changes remain conflicted instead of being silently accepted', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'formatted.txt');
  const files: TextFiles = {
    ...current.files,
    replace: async (file, expected, content) => {
      await current.files.replace(file, expected, content);
      current.data.set(file, 'changed by save participant');
    },
  };
  const journal = new ReviewJournal(
    files,
    new PathGuard([current.root]),
    async () => true,
    async () => {},
  );
  await assert.rejects(journal.write('session', target, 'agent text'), /Save participants/);
  assert.equal(journal.list()[0]!.state, 'conflict');
  await assert.rejects(journal.discard(journal.list()[0]!.id), /newer user or external/);
  assert.equal(current.data.get(target), 'changed by save participant');
});
