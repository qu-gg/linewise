import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../state.js';
import { StorageMaintenance } from '../retention.js';
import { setup } from './extension-setup.js';
import { fixture } from './vscode-fixture.js';
import { transport } from './acp-fixture.js';

async function storage(context: import('node:test').TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-compatibility-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return new StateStore(directory);
}

const legacy = {
  version: 1,
  activeSessionId: 'original',
  sessions: [
    {
      id: 'original',
      root: 'file:///workspace',
      label: 'Legacy',
      turns: [
        {
          id: 'legacy-turn',
          prompt: 'Original prompt',
          status: 'running',
          startedAt: 1,
          attachment: {
            label: 'Original snapshot',
            uri: 'file:///workspace/file.txt',
            text: 'snapshot\r\n',
          },
          blocks: [{ id: 'answer', kind: 'text', text: 'original answer' }],
        },
      ],
    },
  ],
  changes: [
    {
      id: 'pending',
      sessionId: 'original',
      path: '/workspace/file.txt',
      before: 'before\r\n',
      after: 'after\r\n',
      state: 'pending',
      updatedAt: 1,
    },
  ],
};

test('legacy v1 roundtrip preserves review images and attachment aliases without inventing history', async (context) => {
  const store = await storage(context);
  await writeFile(path.join(store.directory, 'state.json'), JSON.stringify(legacy), {
    mode: 0o600,
  });
  await store.load();
  const expected = structuredClone(legacy);
  expected.sessions[0]!.turns[0]!.status = 'cancelled';
  assert.deepEqual(store.data, expected);
  await store.save();
  await store.load();
  assert.deepEqual(store.data, expected);
  await assert.rejects(new StorageMaintenance(store).orphans(), /ownership is ambiguous/);
});

for (const version of [0, 2])
  test(`unsupported state version ${version} refuses non-destructively`, async (context) => {
    const store = await storage(context);
    const target = path.join(store.directory, 'state.json');
    const source = JSON.stringify({ ...legacy, version });
    await writeFile(target, source);
    await assert.rejects(store.load(), /not been overwritten/);
    assert.equal(await readFile(target, 'utf8'), source);
    assert.deepEqual(await readdir(store.directory), ['state.json']);
  });

test('5000-turn persistence, inspection and export remain bounded on the supported local host', async (context) => {
  const store = await storage(context);
  await store.load();
  for (let session = 0; session < 10; session++)
    store.data.sessions.push({
      id: `session-${session}`,
      label: `Session ${session}`,
      root: 'file:///workspace',
      turns: Array.from({ length: 500 }, (_, index) => ({
        id: `turn-${index}`,
        prompt: `Prompt ${index}`,
        startedAt: index,
        status: 'completed',
        blocks: [{ id: `answer-${index}`, kind: 'text', text: 'x'.repeat(2048) }],
      })),
    });
  const started = performance.now();
  await store.save();
  const saved = performance.now();
  await store.load();
  const loaded = performance.now();
  const service = new StorageMaintenance(store);
  const report = await service.inspect();
  const inspected = performance.now();
  const destination = path.join(store.directory, 'inspection-export.json');
  await service.exportSession('session-0', destination);
  const exported = performance.now();
  assert.equal(report.sessionCount, 10);
  assert.equal(report.turnCount, 5000);
  assert.ok(report.serializedStateBytes > 10 * 1024 * 1024);
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).session.turns.length, 500);
  assert.equal(report.automaticDeletion, false);
  const timings = {
    saveMs: saved - started,
    loadMs: loaded - saved,
    inspectMs: inspected - loaded,
    exportMs: exported - inspected,
  };
  for (const milliseconds of Object.values(timings))
    assert.ok(milliseconds < 10000, 'Local scale smoke budget exceeded');
  context.diagnostic(
    JSON.stringify({ turns: report.turnCount, bytes: report.serializedStateBytes, ...timings }),
  );
});

test('runtime probe pins supported OMP and host routes session selection and advertised context commands', async (context) => {
  const host = await setup(context);
  await fixture.commands.get('omp.preflight')!();
  assert.ok(fixture.logs.some((message) => message.includes('Runtime: 18.21.0')));
  transport.version = '18.20.0';
  await fixture.commands.get('omp.preflight')!();
  assert.match(host.status()!.error, /18.21.0 is required/);
  transport.version = '18.21.0';
  await host.request({ type: 'new' });
  const id = host.status()!.sessionId;
  await host.request({ type: 'sessions' });
  assert.equal(host.status()!.sessionId, id);
  await host.request({ type: 'permissions', mode: 'ask' });
  assert.equal(host.status()!.permissions, 'ask');
  await host.request({ type: 'permissions', mode: 'rules' });
  assert.equal(host.status()!.permissions, 'rules');
  await assert.rejects(host.request({ type: 'terminals' }), /No active prompt owns/);
  await transport.client!.handlers.update({
    sessionId: transport.client!.sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'context', description: 'Inspect context' }],
    },
  });
  let prompt = '';
  transport.onPrompt = async (blocks) => {
    prompt = JSON.stringify(blocks);
  };
  await host.request({ type: 'inspectContext' });
  assert.match(prompt, /\/context/);
  assert.equal(host.status()!.busy, false);
});

test('workspace-root changes cancel the active prompt before accepting more host work', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let release!: () => void;
  let entered!: () => void;
  let cancellations = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.onPrompt = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  };
  transport.onCancel = () => {
    cancellations++;
    release();
  };
  const pending = host.request({ type: 'prompt', text: 'Wait for root transition' });
  await started;
  try {
    fixture.roots = [];
    for (const listener of fixture.rootListeners) await listener();
    assert.equal(cancellations, 1);
    await pending;
    assert.equal(host.status()!.busy, false);
    assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
    await assert.rejects(
      host.request({ type: 'prompt', text: 'No root' }),
      /trusted workspace root is no longer available/,
    );
  } finally {
    release();
    await pending;
  }
});
