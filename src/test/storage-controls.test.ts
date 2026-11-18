import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, utimes, truncate, stat } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { fixture, Uri } from './vscode-fixture.js';
import { transport } from './acp-fixture.js';

async function sessions(context: import('node:test').TestContext) {
  const host = await setup(context);
  transport.nextSessionId = 'old';
  await host.request({ type: 'new' });
  await host.request({ type: 'prompt', text: 'Old session' });
  transport.nextSessionId = 'active';
  await host.request({ type: 'new' });
  return host;
}

test('storage export and deletion require confirmation and preserve the active session', async (context) => {
  const host = await sessions(context);
  fixture.saveFile = Uri.file(path.join(host.storage, 'private-export.json'));
  await fixture.commands.get('omp.exportSession')!();
  await assert.rejects(readFile(fixture.saveFile.fsPath), { code: 'ENOENT' });
  fixture.approval = 'Continue';
  await fixture.commands.get('omp.exportSession')!();
  assert.equal(JSON.parse(await readFile(fixture.saveFile.fsPath, 'utf8')).session.id, 'old');
  fixture.approval = undefined;
  await fixture.commands.get('omp.deleteSession')!();
  assert.equal(host.storedState!().sessions.length, 2);
  fixture.approval = 'Continue';
  await fixture.commands.get('omp.deleteSession')!();
  assert.deepEqual(
    host.storedState!().sessions.map((saved) => saved.id),
    ['active'],
  );
  assert.deepEqual(host.status()!.sessionIds, ['active']);
  await fixture.commands.get('omp.deleteSession')!();
  assert.equal(host.storedState!().sessions.length, 1);
});

test('storage confirmation owns the host until cancel and cannot overlap a new session', async (context) => {
  const host = await sessions(context);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.onWarning = async () => {
    entered();
    await released;
    return undefined;
  };
  const deleting = fixture.commands.get('omp.deleteSession')!();
  await started;
  await fixture.commands.get('omp.newSession')!();
  assert.match(host.status()!.error, /current operation/);
  release();
  await deleting;
  assert.equal(host.storedState!().sessions.length, 2);
  assert.equal(host.status()!.busy, false);
});

test('orphan cleanup confirms only aged unreferenced artifacts and retention never silently runs', async (context) => {
  const host = await setup(context);
  const directory = path.join(host.storage, 'omp-sessions');
  await mkdir(directory, { recursive: true });
  const orphan = path.join(directory, 'orphan.jsonl');
  await writeFile(orphan, 'orphan');
  await utimes(orphan, new Date(0), new Date(0));
  await fixture.commands.get('omp.cleanupStorage')!();
  assert.equal(await readFile(orphan, 'utf8'), 'orphan');
  fixture.approval = 'Continue';
  await fixture.commands.get('omp.cleanupStorage')!();
  await assert.rejects(readFile(orphan), { code: 'ENOENT' });
  await fixture.commands.get('omp.cleanupStorage')!();
  await fixture.commands.get('omp.applyRetention')!();
  assert.equal(host.storedState!().sessions.length, 0);
});

test('native budget failure never reaches the provider or loses operation ownership', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'new' });
  const file = path.join(host.storage, 'omp-sessions', `prefix_${host.status()!.sessionId}.jsonl`);
  await writeFile(file, '');
  await truncate(file, 32 * 1024 * 1024);
  let sent = 0;
  transport.onPrompt = async () => {
    sent++;
  };
  await assert.rejects(host.request({ type: 'prompt', text: 'must not send' }), /storage budget/);
  assert.equal(sent, 0);
  assert.equal(host.status()!.busy, false);
  assert.equal(host.status()!.turns.at(-1)!.status, 'failed');
  assert.equal((await stat(file)).size, 32 * 1024 * 1024);
});

test('retired host maintenance cannot borrow replacement-host ownership', async (context) => {
  const old = await sessions(context);
  const command = fixture.commands.get('omp.deleteSession')!;
  const before = await readFile(path.join(old.storage, 'state.json'), 'utf8');
  const { deactivate } = await import('../extension.js');
  await deactivate();
  const replacement = await setup(context);
  fixture.approval = 'Continue';
  await command();
  assert.equal(await readFile(path.join(old.storage, 'state.json'), 'utf8'), before);
  assert.equal(replacement.status()!.error, '');
  assert.equal(replacement.status()!.sessionIds.length, 0);
});
