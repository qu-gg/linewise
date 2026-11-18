import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { StateStore } from '../state.js';
import { fileFaults } from './fs-fault-fixture.js';
register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { StorageMaintenance, retentionCandidates } = await import('../retention.js');
const { removeArtifacts } = await import('../storage-files.js');

async function setup(context: import('node:test').TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-retention-service-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.load();
  await mkdir(path.join(directory, 'omp-sessions'));
  for (const id of ['active', 'old', 'unknown'])
    store.data.sessions.push({
      id,
      label: id,
      root: 'file:///workspace',
      sessionFile: `${id}.jsonl`,
      turns:
        id === 'unknown'
          ? []
          : [{ id: 'turn', prompt: id, status: 'completed', startedAt: 1, blocks: [] }],
    });
  store.data.activeSessionId = 'active';
  for (const id of ['active', 'old'])
    await writeFile(path.join(directory, 'omp-sessions', `${id}.jsonl`), `${id}\n`);
  await store.save();
  return new StorageMaintenance(store);
}

test('retention proposes only known-age unprotected data and export includes native context privately', async (context) => {
  const service = await setup(context);
  assert.deepEqual(retentionCandidates(service.store).candidates, ['old']);
  const destination = path.join(service.store.directory, 'backup.json');
  await service.exportSession('old', destination);
  const exported = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(exported.session.id, 'old');
  assert.deepEqual(exported.artifacts, [{ name: 'old.jsonl', contents: 'old\n' }]);
  const report = await service.inspect();
  assert.equal(report.nativeArtifactBytes, 11);
  assert.equal(report.nativeArtifactSizes, 'regular-jsonl-only');
});

test('session removal commits before unlink and stale confirmation cannot delete', async (context) => {
  const service = await setup(context);
  const plan = await service.planRemoval(['old']);
  service.store.data.sessions[1]!.label = 'new label';
  await assert.rejects(service.remove(plan), /Storage changed/);
  const fresh = await service.planRemoval(['old']);
  assert.deepEqual(await service.remove(fresh), {
    removedSessions: ['old'],
    removedArtifacts: ['old.jsonl'],
  });
  await service.store.load();
  assert.deepEqual(
    service.store.data.sessions.map((saved) => saved.id),
    ['active', 'unknown'],
  );
  assert.equal(
    await readFile(path.join(service.store.directory, 'omp-sessions', 'active.jsonl'), 'utf8'),
    'active\n',
  );
  await assert.rejects(service.planRemoval(['active']), /protected/);
});

test('orphan cleanup observes grace period, ownership changes and recovery ambiguity', async (context) => {
  const service = await setup(context);
  const orphan = path.join(service.store.directory, 'omp-sessions', 'orphan.jsonl');
  await writeFile(orphan, 'orphan\n');
  assert.deepEqual(await service.orphans(), []);
  await utimes(orphan, new Date(0), new Date(0));
  const candidates = await service.orphans();
  assert.deepEqual(
    candidates.map((file) => file.name),
    ['orphan.jsonl'],
  );
  service.store.data.sessions.push({
    id: 'owner',
    label: '',
    root: '',
    turns: [],
    sessionFile: 'orphan.jsonl',
  });
  await assert.rejects(removeArtifacts(service.store, candidates), /referenced/);
  service.store.data.activeSessionId = 'missing';
  await assert.rejects(service.orphans(), /incomplete storage/);
});

test('ambiguous legacy native ownership refuses orphan cleanup without deleting anything', async (context) => {
  const service = await setup(context);
  delete service.store.data.sessions[1]!.sessionFile;
  await assert.rejects(service.orphans(), /ownership is ambiguous/);
  await assert.rejects(removeArtifacts(service.store, []), /ownership is ambiguous/);
  assert.equal(
    await readFile(path.join(service.store.directory, 'omp-sessions', 'old.jsonl'), 'utf8'),
    'old\n',
  );
});

test('post-commit artifact failure reports partial cleanup without resurrecting removed sessions', async (context) => {
  const service = await setup(context);
  const file = path.join(service.store.directory, 'omp-sessions', 'old.jsonl');
  const plan = await service.planRemoval(['old']);
  fileFaults.push({ method: 'unlink', code: 'EIO', path: file });
  await assert.rejects(
    service.remove(plan),
    /Sessions were removed, but some native artifacts remain/,
  );
  await service.store.load();
  assert.deepEqual(
    service.store.data.sessions.map((saved) => saved.id),
    ['active', 'unknown'],
  );
  assert.equal(await readFile(file, 'utf8'), 'old\n');
});

test('orphan confirmation cannot remove an artifact that becomes recent', async (context) => {
  const service = await setup(context);
  const file = path.join(service.store.directory, 'omp-sessions', 'orphan.jsonl');
  await writeFile(file, 'orphan');
  await utimes(file, new Date(0), new Date(0));
  const selected = await service.orphans();
  await utimes(file, new Date(), new Date());
  await assert.rejects(service.cleanupOrphans(selected), /eligibility changed/);
  assert.equal(await readFile(file, 'utf8'), 'orphan');
});

test('session and artifact removal batch limits refuse before persistence', async (context) => {
  const service = await setup(context);
  await assert.rejects(
    service.planRemoval(Array.from({ length: 129 }, (_, index) => `id-${index}`)),
    /at most 128/,
  );
  delete service.store.data.sessions[1]!.sessionFile;
  await Promise.all(
    Array.from({ length: 129 }, (_, index) =>
      writeFile(
        path.join(service.store.directory, 'omp-sessions', `${index}_old.jsonl`),
        'retained',
      ),
    ),
  );
  await assert.rejects(service.planRemoval(['old']), /limited to 128 artifacts/);
  assert.deepEqual(
    service.store.data.sessions.map((saved) => saved.id),
    ['active', 'old', 'unknown'],
  );
});

test('size pressure proposes known-age sessions but never evicts protected or unknown-age data', async (context) => {
  const service = await setup(context);
  const now = Date.now();
  service.store.data.sessions[1]!.turns[0]!.startedAt = now;
  service.store.data.sessions[2]!.label = 'x'.repeat(64 * 1024 * 1024);
  const plan = retentionCandidates(service.store, now);
  assert.deepEqual(plan.candidates, ['old']);
  assert.ok(plan.retainedBytes > plan.limits.maximumStateBytes);
  assert.equal(service.store.data.sessions.length, 3);
});
