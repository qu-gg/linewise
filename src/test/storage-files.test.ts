import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, truncate } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../state.js';
import { TerminalManager } from '../terminal.js';
import { fileFaults } from './fs-fault-fixture.js';
register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { assertNativeBudget, readArtifact, removeArtifacts, scanArtifacts, writePrivateExport } =
  await import('../storage-files.js');

async function storage(context: import('node:test').TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-retention-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.load();
  await mkdir(path.join(directory, 'omp-sessions'));
  return store;
}

test('artifact scanning preserves exact, legacy and recovery references and skips symlinks', async (context) => {
  const store = await storage(context);
  const directory = path.join(store.directory, 'omp-sessions');
  for (const name of ['exact.jsonl', 'prefix_legacy.jsonl', 'recovery.jsonl', 'orphan.jsonl'])
    await writeFile(path.join(directory, name), '{"entry":true}\n');
  await symlink(path.join(directory, 'exact.jsonl'), path.join(directory, 'alias.jsonl'));
  await mkdir(path.join(directory, 'folder.jsonl'));
  store.data.sessions.push(
    { id: 'legacy', label: '', root: '', turns: [] },
    {
      id: 'source',
      label: '',
      root: '',
      turns: [],
      sessionFile: 'exact.jsonl',
      historyTransition: {
        archiveId: 'legacy',
        keepTurns: 0,
        entryId: 'entry',
        before: { sessionId: 'native', leafId: null, entries: [], fileName: 'recovery.jsonl' },
      },
    },
  );
  const files = await scanArtifacts(store);
  assert.deepEqual(
    files.map((file) => file.name),
    ['exact.jsonl', 'orphan.jsonl', 'prefix_legacy.jsonl', 'recovery.jsonl'],
  );
  assert.deepEqual(
    files.map((file) => file.owners),
    [['source'], [], ['legacy'], ['source']],
  );
  const original = files[0]!;
  assert.equal(await readArtifact(store, original), '{"entry":true}\n');
  await assert.rejects(removeArtifacts(store, [original]), /still referenced/);
  const orphan = files.find((file) => !file.owners.length)!;
  assert.deepEqual(await removeArtifacts(store, [orphan]), ['orphan.jsonl']);
  assert.deepEqual(await removeArtifacts(store, [orphan]), []);
});

test('artifact operations refuse changed files, traversal and redirected directories', async (context) => {
  const store = await storage(context);
  const directory = path.join(store.directory, 'omp-sessions');
  const file = path.join(directory, 'orphan.jsonl');
  await writeFile(file, 'before\n');
  const original = (await scanArtifacts(store))[0]!;
  await writeFile(file, 'after\n');
  await assert.rejects(readArtifact(store, original), /changed/);
  await assert.rejects(removeArtifacts(store, [original]), /changed/);
  await assert.rejects(readArtifact(store, { ...original, name: '../state.jsonl' }), /unsupported/);
  await rm(directory, { recursive: true });
  await symlink(store.directory, directory);
  await assert.rejects(scanArtifacts(store), /regular directory/);
});

test('private export is new-only, mode 0600 and cannot follow an existing symlink', async (context) => {
  const store = await storage(context);
  const target = path.join(store.directory, 'export.json');
  await writePrivateExport(target, '{"private":true}');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await assert.rejects(writePrivateExport(target, 'overwrite'), { code: 'EEXIST' });
  const alias = path.join(store.directory, 'alias.json');
  await symlink(target, alias);
  await assert.rejects(writePrivateExport(alias, 'overwrite'), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), '{"private":true}');
});

for (const code of ['ENOSPC', 'EIO', 'EACCES']) {
  for (const method of ['write', 'sync'] as const)
    test(`private export ${method} ${code} removes partial output and permits retry`, async (context) => {
      const store = await storage(context);
      const target = path.join(store.directory, 'failed-export.json');
      fileFaults.push({ method, code, path: target, partial: true });
      await assert.rejects(writePrivateExport(target, 'private session text'), { code });
      await assert.rejects(readFile(target), { code: 'ENOENT' });
      await writePrivateExport(target, 'repaired export');
      assert.equal(await readFile(target, 'utf8'), 'repaired export');
      assert.equal((await stat(target)).mode & 0o777, 0o600);
    });
}

test('artifact export rejects invalid UTF-8, unsupported sizes and a replacement FIFO without blocking', async (context) => {
  const store = await storage(context);
  const file = path.join(store.directory, 'omp-sessions', 'invalid.jsonl');
  await writeFile(file, Buffer.from([0xff]));
  const original = (await scanArtifacts(store))[0]!;
  await assert.rejects(readArtifact(store, original), /encoded data/);
  await assert.rejects(readArtifact(store, { ...original, size: -1 }), /unsupported/);
  await assert.rejects(readArtifact(store, { ...original, size: 33 * 1024 * 1024 }), /unsupported/);
  await rm(file);
  const manager = new TerminalManager({
    sessionId: 'fifo-fixture',
    cwd: store.directory,
    signal: new AbortController().signal,
    approve: async () => true,
  });
  try {
    const terminal = await manager.create({
      sessionId: 'fifo-fixture',
      command: 'mkfifo',
      args: [file],
    });
    const result = await manager.waitForExit({
      sessionId: 'fifo-fixture',
      terminalId: terminal.terminalId,
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await manager.dispose();
  }
  await assert.rejects(readArtifact(store, original), /not a regular file/);
});

test('failed native unlink preserves the artifact and permits an explicit repaired retry', async (context) => {
  const store = await storage(context);
  const file = path.join(store.directory, 'omp-sessions', 'orphan.jsonl');
  await writeFile(file, 'original');
  const selected = await scanArtifacts(store);
  fileFaults.push({ method: 'unlink', code: 'EACCES', path: file });
  await assert.rejects(removeArtifacts(store, selected), { code: 'EACCES' });
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.deepEqual(await removeArtifacts(store, selected), ['orphan.jsonl']);
});

test('native admission budget retains oversized history and refuses growth at its boundary', async (context) => {
  const store = await storage(context);
  const file = path.join(store.directory, 'omp-sessions', 'large.jsonl');
  await writeFile(file, '');
  store.data.sessions.push({
    id: 'large',
    label: '',
    root: '',
    turns: [],
    sessionFile: 'large.jsonl',
  });
  await truncate(file, 32 * 1024 * 1024);
  await assert.rejects(assertNativeBudget(store, 'large'), /storage budget/);
  assert.equal((await stat(file)).size, 32 * 1024 * 1024);
  await assertNativeBudget(store, 'unrelated');
  await truncate(file, 32 * 1024 * 1024 - 1);
  await assertNativeBudget(store, 'large');
});
