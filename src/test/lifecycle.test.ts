import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';
import { fixture } from './vscode-fixture.js';

const { StateStore } = await import('../state.js');
const { MutationBroker } = await import('../mutations.js');
const { HostTools } = await import('../host-tools.js');

test('fresh-user authentication errors keep login guidance but redact credentials in UI and logs', async (context) => {
  const host = await setup(context);
  context.mock.method(OmpClient.prototype, 'start', async () => {
    throw new Error(
      'Authentication required; /login github-copilot. Bearer fixture-secret ghp_fixtureTOKEN github_pat_fixturePAT api_key=fixture-key access_token=fixture-access',
    );
  });
  await fixture.commands.get('omp.newSession')!();
  assert.match(host.status()!.error, /\/login github-copilot/);
  const output = host.status()!.error + fixture.logs.join('\n');
  for (const secret of [
    'fixture-secret',
    'fixtureTOKEN',
    'fixturePAT',
    'fixture-key',
    'fixture-access',
  ])
    assert.ok(!output.includes(secret));
  assert.equal(host.status()!.connected, false);
});

for (const failure of ['config', 'memory', 'model'] as const) {
  test(`host ${failure} startup failure releases ownership and preserves a clean retry`, async (context) => {
    const host = await setup(context);
    const config = path.join(host.storage, 'session-config.json');
    const start = OmpClient.prototype.start;
    const mocked = context.mock.method(
      OmpClient.prototype,
      'start',
      async function (this: OmpClient, options: Parameters<OmpClient['start']>[0]) {
        await start.call(this, options);
        if (failure === 'model')
          this.configOptions = [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'other/local',
              options: [{ name: 'Other model', value: 'other/local' }],
            },
          ];
      },
    );
    if (failure === 'config') await mkdir(config);
    if (failure === 'memory') transport.configError = new Error('Memory settings query failed');
    await assert.rejects(
      host.request({ type: 'connect' }),
      failure === 'config'
        ? /EISDIR/
        : failure === 'memory'
          ? /Memory settings query failed/
          : /No GitHub Copilot models are authenticated.*\/login/,
    );
    assert.equal(host.status()!.connected, false);
    assert.equal(host.status()!.connecting, false);
    assert.equal(host.status()!.busy, false);
    assert.equal(host.status()!.approval, undefined);
    assert.deepEqual(host.storedState!().sessions, []);
    assert.deepEqual(host.storedState!().changes, []);
    mocked.mock.restore();
    if (failure === 'config') await rm(config, { recursive: true });
    transport.configError = undefined;
    await host.request({ type: 'connect' });
    assert.equal(host.status()!.connected, true);
  });
}

test('Stop refuses unsupported startup cancellation without corrupting the pending connection', async (context) => {
  const host = await setup(context);
  const start = OmpClient.prototype.start;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  context.mock.method(
    OmpClient.prototype,
    'start',
    async function (this: OmpClient, options: Parameters<OmpClient['start']>[0]) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await start.call(this, options);
    },
  );
  const pending = host.request({ type: 'connect' });
  await started;
  await assert.rejects(host.request({ type: 'cancel' }), /current operation/);
  release();
  await pending;
  assert.equal(host.status()!.connecting, false);
  assert.equal(host.status()!.connected, true);
});

function promptPause() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  return {
    started,
    release,
    hold: async () => {
      if (held) return;
      held = true;
      entered();
      await released;
    },
  };
}

for (const phase of ['broker', 'history', 'pre-send', 'provider', 'cleanup', 'final-save']) {
  test(
    `Stop during ${phase} retires prompt ownership without stale dispatch or replay`,
    { timeout: 5000 },
    async (context) => {
      const host = await setup(context);
      await host.request({ type: 'connect' });
      const { started, release, hold } = promptPause();
      let sent = 0;
      if (phase === 'broker') {
        const start = MutationBroker.prototype.start;
        context.mock.method(
          MutationBroker.prototype,
          'start',
          async function (this: InstanceType<typeof MutationBroker>) {
            await hold();
            await start.call(this);
          },
        );
      }
      if (phase === 'history') {
        transport.client!.historyAvailable = true;
        context.mock.method(transport.client!, 'history', async () => {
          await hold();
          return { sessionId: 'native-session', leafId: null, entries: [] };
        });
      }
      const save = StateStore.prototype.save;
      context.mock.method(
        StateStore.prototype,
        'save',
        async function (this: InstanceType<typeof StateStore>) {
          const status = this.data.sessions[0]?.turns.at(-1)?.status;
          if (
            (phase === 'pre-send' && status === 'running') ||
            (phase === 'final-save' && status === 'completed')
          )
            await hold();
          await save.call(this);
        },
      );
      if (phase === 'cleanup') {
        const finish = HostTools.prototype.finish;
        context.mock.method(
          HostTools.prototype,
          'finish',
          async function (this: InstanceType<typeof HostTools>) {
            if (sent) await hold();
            await finish.call(this);
          },
        );
      }
      transport.onPrompt = async () => {
        sent++;
        if (phase === 'provider') {
          await hold();
          throw new Error('Fixture stopped');
        }
      };
      const pending = host.request({ type: 'prompt', text: `Stop at ${phase}` });
      await started;
      const cancelled = host.request({ type: 'cancel' });
      release();
      await Promise.all([pending, cancelled]);
      assert.equal(sent, ['provider', 'cleanup', 'final-save'].includes(phase) ? 1 : 0);
      assert.equal(
        host.status()!.turns.at(-1)!.status,
        ['cleanup', 'final-save'].includes(phase) ? 'completed' : 'cancelled',
      );
      assert.equal(host.status()!.busy, false);
      assert.equal(host.status()!.approval, undefined);
      assert.deepEqual(host.storedState!().changes, []);
    },
  );
}
