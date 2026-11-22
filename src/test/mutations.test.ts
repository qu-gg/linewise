import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  exchangeMutation,
  exchangeMutations,
  MutationBroker,
  mutationId,
  mutationSchema,
  serveMutation,
  stagePermit,
  cleanupMutation,
  completeMutation,
} from '../mutations.js';

test('cancelled caller cleanup cannot unlink the broker response between write and atomic rename', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-response-owner-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const response = path.join(directory, `response-${id}.json`);
  const content = JSON.stringify({ id, ok: true, text: 'completed response' });
  await writeFile(`${response}.tmp`, content, { mode: 0o600 });
  await cleanupMutation(directory, id);
  assert.equal(await readFile(`${response}.tmp`, 'utf8'), content);
  await rename(`${response}.tmp`, response);
  assert.equal(await completeMutation(directory, id), 'completed response');
  assert.deepEqual(await readdir(directory), []);
  await writeFile(`${response}.tmp`, content, { mode: 0o600 });
  await cleanupMutation(directory, id, 'broker');
  assert.deepEqual(await readdir(directory), []);
});

test('private mutation exchange binds identity, validates exact preimages and cleans envelopes', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-mutation-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'control');
  const operation = {
    op: 'write' as const,
    path: '/workspace/file.txt',
    before: 'before',
    content: 'after',
  };
  assert.equal(
    await exchangeMutation(directory, operation, async (title) => {
      await serveMutation(directory, mutationId(title)!, async (mutation) => {
        assert.deepEqual(mutation, operation);
        return 'after';
      });
    }),
    'after',
  );
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(
    exchangeMutation(directory, operation, async (title) => {
      assert.equal(
        await serveMutation(directory, mutationId(title)!, async () => {
          throw new Error('stale');
        }),
        false,
      );
    }),
    /stale/,
  );
  assert.deepEqual(await readdir(directory), []);
  assert.equal(mutationId('unrelated approval'), undefined);
  assert.equal(mutationId('vs-omp-mutation ../escape'), undefined);
  assert.equal(mutationSchema.safeParse({ ...operation, extra: true }).success, false);
  await assert.rejects(
    serveMutation(directory, '../escape', async () => null),
    /identity/,
  );
  await assert.rejects(
    exchangeMutation(directory, operation, async (title) => {
      await writeFile(
        path.join(directory, `response-${mutationId(title)}.json`),
        JSON.stringify({ id: randomUUID(), ok: true, text: null }),
        { mode: 0o600 },
      );
    }),
    /identity mismatch/,
  );
  await chmod(directory, 0o755);
  await assert.rejects(
    exchangeMutation(directory, operation, async () => {}),
    /private canonical/,
  );
});

test('prompt broker applies exact batches once and retires its authority before the next prompt', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-broker-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const operations = [{ op: 'delete' as const, path: '/workspace/file.txt', before: 'original' }];
  const received: unknown[] = [];
  const broker = new MutationBroker(
    directory,
    async (mutation) => {
      received.push(mutation);
      return null;
    },
    new AbortController().signal,
  );
  await broker.start();
  try {
    await stagePermit(directory, randomUUID(), 'unconsumed command');
    await exchangeMutations(directory, operations);
    assert.deepEqual(received, operations);
  } finally {
    await broker.close();
  }
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(exchangeMutations(directory, operations), /ENOENT/);
});

test('batch failure reports completed operations, retains their results, and stops before later files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-batch-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const applied: string[] = [];
  const broker = new MutationBroker(
    directory,
    async (mutation) => {
      if (!('path' in mutation)) throw new Error('Expected a file mutation.');
      if (mutation.path === '/second.txt') throw new Error('injected save failure');
      applied.push(mutation.path);
      return null;
    },
    new AbortController().signal,
  );
  await broker.start();
  try {
    await assert.rejects(
      exchangeMutations(
        directory,
        ['/first.txt', '/second.txt', '/third.txt'].map((target) => ({
          op: 'delete' as const,
          path: target,
          before: 'before',
        })),
      ),
      /1 operations completed; completed or interrupted changes remain in review/,
    );
    assert.deepEqual(applied, ['/first.txt']);
  } finally {
    await broker.close();
  }
});

test('broker rejects retired tokens, propagates refusal, and cancellation closes an unanswered exchange', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-broker-refuse-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const operation = { op: 'delete' as const, path: '/workspace/file.txt', before: 'original' };
  let calls = 0;
  const broker = new MutationBroker(
    directory,
    async () => {
      calls++;
      throw new Error('host refusal');
    },
    new AbortController().signal,
  );
  await broker.start();
  const active = path.join(directory, 'active.json');
  const original = await readFile(active);
  try {
    await writeFile(active, JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
    await assert.rejects(exchangeMutations(directory, [operation]), /retired prompt/);
    assert.equal(calls, 0);
    await writeFile(active, original);
    await assert.rejects(exchangeMutations(directory, [operation]), /host refusal/);
    assert.equal(calls, 1);
  } finally {
    await broker.close();
  }
  await writeFile(active, original, { mode: 0o600 });
  const abort = new AbortController();
  const rejected = assert.rejects(exchangeMutations(directory, [operation], abort.signal));
  abort.abort();
  await rejected;
  await rm(active);
  await chmod(directory, 0o755);
  const invalid = new MutationBroker(directory, async () => null, new AbortController().signal);
  await assert.rejects(invalid.start(), /private canonical/);
});
