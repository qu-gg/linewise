import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { fileFaults } from './fs-fault-fixture.js';
import { transport } from './acp-fixture.js';

const { StateStore } = await import('../state.js');

test('a queued save cannot resurrect a durably removed session', async (context) => {
  const host = await setup(context);
  const store = new StateStore(path.join(host.storage, 'removal'));
  await store.load();
  store.data.sessions.push({ id: 'old', label: 'old', root: 'file:///workspace', turns: [] });
  await store.save();
  await Promise.all([store.updateSessions(() => []), store.save()]);
  await store.load();
  assert.deepEqual(store.data.sessions, []);
});

test('state budget rejects growth but permits legacy oversized state to shrink', async (context) => {
  const host = await setup(context);
  const store = new StateStore(path.join(host.storage, 'budget'), 256);
  await store.load();
  store.data.sessions.push({ id: 'legacy', root: '', label: 'x'.repeat(300), turns: [] });
  await assert.rejects(store.save(), /storage budget/);
  const legacy = new StateStore(store.directory);
  legacy.data = structuredClone(store.data);
  await legacy.save();
  await store.load();
  store.data.sessions[0]!.label = 'x'.repeat(290);
  await store.save();
  store.data.sessions[0]!.label = 'x'.repeat(310);
  await assert.rejects(store.save(), /storage budget/);
  await store.updateSessions(() => []);
  await store.load();
  assert.deepEqual(store.data.sessions, []);
});

for (const code of ['ENOSPC', 'EIO', 'EACCES']) {
  test(`session removal ${code} rolls back before the next queued save`, async (context) => {
    const host = await setup(context);
    const store = new StateStore(path.join(host.storage, 'removal'));
    await store.load();
    store.data.sessions.push({ id: 'old', label: 'old', root: 'file:///workspace', turns: [] });
    await store.save();
    fileFaults.push({ method: 'rename', code, path: '.tmp' });
    const removed = assert.rejects(
      store.updateSessions(() => []),
      { code },
    );
    const concurrent = store.save();
    await Promise.all([removed, concurrent]);
    assert.equal(store.data.sessions[0]!.id, 'old');
    await store.load();
    assert.equal(store.data.sessions[0]!.id, 'old');
  });
  for (const method of ['write', 'rename'] as const) {
    test(`${method} ${code} retains committed state, removes partial output and permits repair`, async (context) => {
      const host = await setup(context);
      const store = new StateStore(path.join(host.storage, 'fault-store'));
      await store.load();
      store.data.sessions.push({
        id: 'source',
        label: 'committed',
        root: 'file:///workspace',
        turns: [],
      });
      await store.save();
      const file = path.join(store.directory, 'state.json');
      const committed = await readFile(file, 'utf8');
      store.data.sessions[0]!.label = 'not committed';
      fileFaults.push({ method, code, path: '.tmp', partial: true });
      await assert.rejects(store.save(), { code });
      assert.equal(await readFile(file, 'utf8'), committed);
      assert.deepEqual(await readdir(store.directory), ['state.json']);
      const recovered = new StateStore(store.directory);
      await recovered.load();
      assert.equal(recovered.data.sessions[0]!.label, 'committed');
      await store.save();
      await recovered.load();
      assert.equal(recovered.data.sessions[0]!.label, 'not committed');
    });
  }
  test(`configuration ${code} refuses startup and permits an explicit repaired retry`, async (context) => {
    const host = await setup(context);
    fileFaults.push({ method: 'write', code, path: 'session-config.json' });
    await assert.rejects(host.request({ type: 'connect' }), { code });
    assert.equal(host.status()!.connected, false);
    assert.equal(host.status()!.connecting, false);
    assert.deepEqual(host.storedState!().sessions, []);
    await host.request({ type: 'connect' });
    assert.equal(host.status()!.connected, true);
  });
  test(`pre-send ${code} never reaches the provider or loses operation ownership`, async (context) => {
    const host = await setup(context);
    await host.request({ type: 'connect' });
    let sent = 0;
    transport.onPrompt = async () => {
      sent++;
    };
    fileFaults.push({ method: 'write', code, path: '.tmp', partial: true });
    await assert.rejects(host.request({ type: 'prompt', text: 'Do not send on storage failure' }), {
      code,
    });
    assert.equal(sent, 0);
    assert.equal(host.status()!.busy, false);
    assert.equal(host.status()!.turns.at(-1)!.status, 'failed');
    await host.request({ type: 'prompt', text: 'Explicit repaired retry' });
    assert.equal(sent, 1);
  });
  test(`memory settings ${code} refuses startup without losing state and allows repaired retry`, async (context) => {
    const host = await setup(context);
    transport.configError = Object.assign(new Error('Memory settings unavailable'), { code });
    await assert.rejects(host.request({ type: 'connect' }), { code });
    assert.equal(host.status()!.connected, false);
    assert.equal(host.status()!.connecting, false);
    assert.deepEqual(host.storedState!().sessions, []);
    assert.deepEqual(host.storedState!().changes, []);
    transport.configError = undefined;
    await host.request({ type: 'connect' });
    assert.equal(host.status()!.connected, true);
  });
  test(`Stop combined with final-save ${code} releases ownership and reload never replays`, async (context) => {
    const host = await setup(context);
    await host.request({ type: 'connect' });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    transport.onPrompt = async () => {
      sent++;
      entered();
      await stopped;
    };
    transport.onCancel = release;
    const pending = assert.rejects(
      host.request({ type: 'prompt', text: 'Stop with unavailable storage' }),
      { code },
    );
    await started;
    const changes = structuredClone(host.storedState!().changes);
    fileFaults.push({ method: 'write', code, path: '.tmp', partial: true });
    await host.request({ type: 'cancel' });
    await pending;
    assert.equal(sent, 1);
    assert.equal(host.status()!.busy, false);
    assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
    assert.equal(host.status()!.approval, undefined);
    assert.deepEqual(host.storedState!().changes, changes);
    const reopened = new StateStore(host.storage);
    await reopened.load();
    assert.equal(reopened.data.sessions.at(-1)!.turns.at(-1)!.status, 'cancelled');
    assert.equal(sent, 1);
    await host.request({ type: 'prompt', text: 'Explicit continuation after repair' });
    assert.equal(sent, 2);
    assert.equal(host.status()!.turns.at(-1)!.status, 'completed');
  });
}
