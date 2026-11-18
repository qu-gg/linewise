import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { OmpClient } from '../acp.js';

async function fixture(context: TestContext, args: string[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-transport-unit-'));
  const executable = path.join(directory, 'fixture-agent');
  const previous = {
    node: process.env.VS_OMP_FIXTURE_NODE,
    agent: process.env.VS_OMP_FIXTURE_AGENT,
  };
  process.env.VS_OMP_FIXTURE_NODE = process.execPath;
  process.env.VS_OMP_FIXTURE_AGENT = fileURLToPath(new URL('./acp-agent.js', import.meta.url));
  await writeFile(
    executable,
    '#!/bin/sh\nexec "$VS_OMP_FIXTURE_NODE" "$VS_OMP_FIXTURE_AGENT" "$@"\n',
    { mode: 0o700 },
  );
  const updates: string[] = [];
  const logs: string[] = [];
  let receivedLog!: () => void;
  const logged = new Promise<void>((resolve) => {
    receivedLog = resolve;
  });
  let entered = () => {};
  const client = new OmpClient(
    {
      update: async (notification) => {
        updates.push(JSON.stringify(notification));
        if (JSON.stringify(notification).includes('waiting')) entered();
      },
      read: async () => '',
      write: async () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    },
    (message) => {
      logs.push(message);
      receivedLog();
    },
  );
  context.after(async () => {
    await client.stop();
    for (const [name, value] of [
      ['VS_OMP_FIXTURE_NODE', previous.node],
      ['VS_OMP_FIXTURE_AGENT', previous.agent],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    client,
    updates,
    logs,
    logged,
    options: { executable, cwd: directory, artifacts: directory, args },
    waiting: () =>
      new Promise<void>((resolve) => {
        entered = resolve;
      }),
  };
}

test(
  'real ACP transport negotiates, filters private commands, redacts stderr and shuts down idempotently',
  { timeout: 5000 },
  async (context) => {
    const current = await fixture(context);
    await current.client.start(current.options);
    assert.equal(current.client.connected, true);
    assert.equal(current.client.historyAvailable, true);
    assert.ok(current.updates.some((value) => value.includes('context')));
    assert.ok(current.updates.every((value) => !value.includes('vs-omp-history')));
    await current.logged;
    assert.ok(current.logs.join('').includes('[redacted]'));
    assert.ok(!current.logs.join('').includes('fixture-token'));
    await assert.rejects(current.client.start(current.options), /already active/);
    await current.client.setConfig('model', 'second');
    assert.equal(current.client.configOptions[0]!.currentValue, 'second');
    assert.equal(
      (await current.client.prompt([{ type: 'text', text: 'hello' }])).stopReason,
      'end_turn',
    );
    assert.equal((await current.client.history()).sessionId, 'durable');
    assert.equal((await current.client.fork()).sessionId, 'forked');
    await current.client.closeSession('forked');
    await assert.rejects(current.client.closeSession('native'), /Disconnect/);
    await current.client.selectSession('loaded');
    assert.equal(current.client.sessionId, 'loaded');
    await Promise.all([current.client.stop(), current.client.stop()]);
    assert.equal(current.client.connected, false);
    assert.equal(current.client.sessionId, undefined);
    assert.deepEqual(current.client.configOptions, []);
  },
);

test('real ACP transport serializes operations and cancellation unblocks a pending prompt', async (context) => {
  const current = await fixture(context);
  await current.client.start({ ...current.options, sessionId: 'saved' });
  assert.equal(current.client.sessionId, 'saved');
  const entered = current.waiting();
  const pending = current.client.prompt([{ type: 'text', text: 'wait' }]);
  await entered;
  await assert.rejects(current.client.setConfig('model', 'second'), /current OMP operation/);
  await assert.rejects(current.client.history(), /current OMP operation/);
  await current.client.cancel();
  assert.equal((await pending).stopReason, 'cancelled');
  await current.client.setConfig('model', 'second');
});

test('real ACP transport refuses incompatible runtime and non-independent fork identity', async (context) => {
  const bad = await fixture(context, ['--bad-version']);
  await assert.rejects(bad.client.start(bad.options), /18.21.0/);
  assert.equal(bad.client.connected, false);
  const same = await fixture(context, ['--same-fork']);
  await same.client.start(same.options);
  await assert.rejects(same.client.fork(), /independent fork/);
});

test('disconnected transport operations fail closed and missing executable does not retain process state', async (context) => {
  const current = await fixture(context);
  await assert.rejects(current.client.prompt([]), /Start an OMP/);
  await assert.rejects(current.client.setConfig('model', 'value'), /Start an OMP/);
  await assert.rejects(current.client.history(), /unavailable/);
  await assert.rejects(current.client.fork(), /unavailable/);
  await current.client.cancel();
  await assert.rejects(
    current.client.start({ ...current.options, executable: '/nonexistent/omp-unit-fixture' }),
    /ENOENT/,
  );
  await current.client.stop();
  assert.equal(current.client.connected, false);
});

test(
  'malformed ACP frames cannot dispatch updates and a valid later request still works',
  { timeout: 5000 },
  async (context) => {
    const current = await fixture(context);
    await current.client.start(current.options);
    const updates = current.updates.length;
    await current.client.prompt([{ type: 'text', text: 'malformed' }]);
    assert.equal(current.updates.length, updates);
    assert.equal(current.client.connected, true);
    assert.equal(
      (await current.client.prompt([{ type: 'text', text: 'valid' }])).stopReason,
      'end_turn',
    );
  },
);

for (const failure of ['oversized', 'exit']) {
  test(
    `real ACP ${failure} rejects a pending prompt and can restart without retaining stale ownership`,
    { timeout: 5000 },
    async (context) => {
      const current = await fixture(context);
      await current.client.start(current.options);
      await assert.rejects(current.client.prompt([{ type: 'text', text: failure }]));
      assert.equal(current.client.connected, false);
      await current.client.stop();
      await current.client.start(current.options);
      assert.equal(
        (await current.client.prompt([{ type: 'text', text: 'restarted' }])).stopReason,
        'end_turn',
      );
    },
  );
}

test('fresh-user authentication refusal is actionable and startup state is released', async (context) => {
  const current = await fixture(context, ['--unauthenticated']);
  await assert.rejects(
    current.client.start(current.options),
    /Authentication required.*\/login github-copilot/,
  );
  assert.equal(current.client.connected, false);
  assert.deepEqual(current.client.configOptions, []);
  assert.ok(current.logs.every((line) => !line.includes('fixture-token')));
  await current.client.start({ ...current.options, args: [] });
  assert.equal(current.client.connected, true);
});
