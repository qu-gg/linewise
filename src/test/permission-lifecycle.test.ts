import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';

test('new chats inherit the workbench permission mode and the first prompt keeps it', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await host.request({ type: 'permissions', mode: 'yolo', confirmed: true });
  await host.request({ type: 'new' });
  assert.equal(host.status()!.permissions, 'yolo');
  const sessions = host.storedState!().sessions.length;
  transport.client!.connected = false;
  transport.onPrompt = async () => {
    const client = transport.client!;
    const handle = await client.handlers.terminals!.create({
      sessionId: client.sessionId,
      command: '/bin/bash',
      args: ['-c', 'printf INHERITED_YOLO'],
    });
    const request = { sessionId: client.sessionId, ...handle };
    assert.equal((await client.handlers.terminals!.waitForExit(request)).exitCode, 0);
    assert.equal(client.handlers.terminals!.output(request).output, 'INHERITED_YOLO');
    await client.handlers.terminals!.release(request);
  };
  await host.request({ type: 'prompt', text: 'Run the inherited shell fixture' });
  assert.equal(host.status()!.permissions, 'yolo');
  assert.equal(host.status()!.turns.at(-1)!.status, 'completed');
  assert.equal(host.storedState!().sessions.length, sessions);
  assert.equal(fixture.warnings.length, 0);
});

test('a prompt during an in-flight permission change fails with an actionable message', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const changing = host.request({ type: 'permissions', mode: 'ask' });
  const prompting = host.request({ type: 'prompt', text: 'Too early' });
  await assert.rejects(prompting, /permission or model change/);
  await changing;
  assert.equal(host.status()!.permissions, 'ask');
  assert.deepEqual(host.status()!.turns, []);
});

test('a failed reconnect discards stale tools but keeps the cached permission mode', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await host.request({ type: 'permissions', mode: 'ask' });
  const start = OmpClient.prototype.start;
  try {
    OmpClient.prototype.start = async function (options) {
      await start.call(this, options);
      throw new Error('connection failed after tool creation');
    };
    await assert.rejects(host.request({ type: 'connect' }), /connection failed/);
    await assert.rejects(
      host.request({ type: 'permissions', mode: 'rules' }),
      /Start a session before changing permissions/,
    );
    assert.equal(host.status()!.permissions, 'ask');
  } finally {
    OmpClient.prototype.start = start;
  }
});

test('workspace trust loss clears an inherited elevated permission mode', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await host.request({ type: 'permissions', mode: 'yolo', confirmed: true });
  fixture.trusted = false;
  await assert.rejects(host.request({ type: 'connect' }), /Trust this workspace/);
  assert.equal(host.status()!.permissions, 'rules');
});
