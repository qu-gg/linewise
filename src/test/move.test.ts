import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, ReviewJournal } from '../review.js';
import type { Change, TextFiles } from '../review.js';

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-move-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const data = new Map<string, string>();
  let saved: readonly Change[] = [];
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
    async () => false,
    async (changes) => {
      saved = structuredClone(changes);
    },
  );
  return {
    root,
    data,
    files,
    journal,
    saved: () => saved,
    source: path.join(root, 'source.txt'),
    destination: path.join(root, 'destination.txt'),
  };
}

test('paired move has one durable review owner and cumulative Discard restores both paths', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'user baseline\r\n');
  await current.journal.write('owner', current.source, 'agent edit\r\n');
  await current.journal.move('owner', current.source, current.destination);
  assert.equal(current.data.has(current.source), false);
  assert.equal(current.data.get(current.destination), 'agent edit\r\n');
  assert.equal(current.journal.list().length, 1);
  assert.equal(current.saved()[0]!.destination!.path, current.destination);
  await assert.rejects(
    current.journal.write('other', current.destination, 'takeover'),
    /owning session/,
  );
  await assert.rejects(
    current.journal.write('owner', current.destination, 'unpaired edit'),
    /paired move/,
  );
  const recovered = new ReviewJournal(
    current.files,
    new PathGuard([current.root]),
    async () => false,
    async () => {},
    current.saved(),
  );
  await recovered.refresh();
  await recovered.discard(recovered.list()[0]!.id);
  assert.equal(current.data.get(current.source), 'user baseline\r\n');
  assert.equal(current.data.has(current.destination), false);
});

test('move refuses collisions, missing sources and newer destination work without destructive rollback', async (context) => {
  const current = await fixture(context);
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination),
    /missing/,
  );
  current.data.set(current.source, 'source');
  await assert.rejects(
    current.journal.move('owner', current.source, current.source),
    /must differ/,
  );
  current.data.set(current.destination, 'user destination');
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination),
    /already exists/,
  );
  current.data.delete(current.destination);
  await current.journal.move('owner', current.source, current.destination);
  current.data.set(current.destination, 'newer user work');
  await assert.rejects(current.journal.discard(current.journal.list()[0]!.id), /newer user/);
  assert.equal(current.data.has(current.source), false);
  assert.equal(current.data.get(current.destination), 'newer user work');
  await current.journal.keep(current.journal.list()[0]!.id);
  assert.equal(current.data.get(current.destination), 'newer user work');
});

test('partial move survives restart and can recover without losing an edited source baseline', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'baseline');
  await current.journal.write('owner', current.source, 'agent');
  const replace = current.files.replace;
  current.files.replace = async (target, before, after) => {
    if (target === current.source && after === null) throw new Error('injected unlink failure');
    await replace(target, before, after);
  };
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination),
    /injected/,
  );
  assert.equal(current.data.get(current.source), 'agent');
  assert.equal(current.data.get(current.destination), 'agent');
  const recovered = new ReviewJournal(
    current.files,
    new PathGuard([current.root]),
    async () => false,
    async () => {},
    current.saved(),
  );
  await recovered.refresh();
  assert.equal(recovered.list()[0]!.state, 'conflict');
  const snapshot = recovered.list();
  snapshot[0]!.destination!.after = 'tampered snapshot';
  assert.equal(recovered.list()[0]!.destination!.after, 'agent');
  current.files.replace = replace;
  await recovered.discard(recovered.list()[0]!.id);
  assert.equal(current.data.get(current.source), 'baseline');
  assert.equal(current.data.has(current.destination), false);
});

test('interrupted rollback retains both paths and refuses save-participant changes', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'baseline');
  await current.journal.move('owner', current.source, current.destination);
  const replace = current.files.replace;
  current.files.replace = async (target, before, after) => {
    await replace(target, before, after);
    if (target === current.source) current.data.set(target, 'save participant');
  };
  await assert.rejects(
    current.journal.discard(current.journal.list()[0]!.id),
    /Restoration changed/,
  );
  assert.equal(current.data.get(current.destination), 'baseline');
  current.files.replace = replace;
  await assert.rejects(current.journal.discard(current.journal.list()[0]!.id), /newer user/);
  assert.equal(current.data.get(current.source), 'save participant');
});

test('native preconditions refuse stale input and edited moves commit as a single paired operation', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'before');
  await assert.rejects(
    current.journal.write('owner', current.source, 'after', undefined, 'stale'),
    /preimage/,
  );
  await assert.rejects(
    current.journal.delete('owner', current.source, undefined, 'stale'),
    /preimage/,
  );
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination, undefined, {
      before: 'stale',
      after: 'after',
    }),
    /preimage/,
  );
  current.files.move = async (source, destination, expected, content) => {
    assert.equal(current.data.get(source), expected);
    current.data.delete(source);
    current.data.set(destination, content);
  };
  await current.journal.move('owner', current.source, current.destination, undefined, {
    before: 'before',
    after: 'after',
  });
  assert.equal(current.data.get(current.destination), 'after');
  await current.journal.discard(current.journal.list()[0]!.id);
  assert.equal(current.data.get(current.source), 'before');
});

test('edited rename interrupted after the physical rename can restore through the metadata-preserving move adapter', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'before');
  const moving: string[] = [];
  current.files.move = async (source, destination) => {
    moving.push(source);
    current.data.set(destination, current.data.get(source)!);
    current.data.delete(source);
    throw new Error('injected post-rename failure');
  };
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination, undefined, {
      before: 'before',
      after: 'after',
    }),
    /post-rename/,
  );
  assert.equal(current.data.get(current.destination), 'before');
  current.files.move = async (source, destination, expected, content) => {
    moving.push(source);
    assert.equal(current.data.get(source), expected);
    current.data.set(destination, content);
    current.data.delete(source);
  };
  await current.journal.discard(current.journal.list()[0]!.id);
  assert.deepEqual(moving, [current.source, current.destination]);
  assert.equal(current.data.get(current.source), 'before');
  assert.equal(current.data.has(current.destination), false);
});

test('destructive aliases and unapproved outside moves leave all preimages unchanged', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'source');
  const outside = `${current.root}-outside.txt`;
  await assert.rejects(current.journal.move('owner', current.source, outside), /not approved/);
  await writeFile(current.source, 'source');
  const alias = path.join(current.root, 'alias.txt');
  await symlink(current.source, alias);
  await assert.rejects(current.journal.delete('owner', alias), /symbolic-link aliases/);
  await assert.rejects(
    current.journal.move('owner', alias, current.destination),
    /symbolic-link aliases/,
  );
  assert.equal(current.data.get(current.source), 'source');
  assert.deepEqual(current.journal.list(), []);
});

test('recovery removes an unapplied paired intent only when both original preimages still match', async (context) => {
  const current = await fixture(context);
  current.data.set(current.source, 'original');
  current.files.move = async () => {
    throw new Error('injected before rename');
  };
  await assert.rejects(
    current.journal.move('owner', current.source, current.destination),
    /before rename/,
  );
  assert.equal(current.journal.list()[0]!.state, 'applying');
  await current.journal.refresh();
  assert.deepEqual(current.journal.list(), []);
  assert.equal(current.data.get(current.source), 'original');
  assert.equal(current.data.has(current.destination), false);
});
