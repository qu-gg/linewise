import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';
import { fixture, Uri } from './vscode-fixture.js';

const { StateStore } = await import('../state.js');
const { MutationBroker } = await import('../mutations.js');
const { HostTools } = await import('../host-tools.js');

test('Close Owned Browser command revokes an idle connection without disconnecting', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let closed = 0;
  context.mock.method(HostTools.prototype, 'closeBrowser', async () => {
    closed++;
  });
  await fixture.commands.get('omp.closeBrowser')!();
  assert.equal(closed, 1);
  assert.equal(host.status()!.connected, true);
  assert.equal(host.status()!.busy, false);
  assert.deepEqual(host.storedState!().changes, []);
});

test('Open in VS Code Browser command forwards URLs and handles missing input', async (context) => {
  await setup(context);
  await fixture.commands.get('omp.openInBrowser')!('https://example.com');
  assert.deepEqual(fixture.commandCalls.at(-1), {
    id: 'workbench.action.browser.open',
    args: [{ url: 'https://example.com/', openToSide: false }],
  });
  await fixture.commands.get('omp.openInBrowser')!(Uri.parse('https://example.com/uri'));
  assert.deepEqual(fixture.commandCalls.at(-1), {
    id: 'workbench.action.browser.open',
    args: [{ url: 'https://example.com/uri', openToSide: false }],
  });
  const calls = fixture.commandCalls.length;
  await fixture.commands.get('omp.openInBrowser')!();
  assert.equal(fixture.commandCalls.length, calls);
});

test('workspace folder events revoke retained browser pages even between prompts', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let closed = 0;
  context.mock.method(HostTools.prototype, 'closeBrowser', async () => {
    closed++;
  });
  assert.equal(fixture.rootListeners.length, 1);
  await fixture.rootListeners[0]!();
  assert.equal(closed, 1);
  assert.equal(host.status()!.connected, true);
});

test('workspace folder events retain browser revocation when cancellation fails', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let closed = 0;
  context.mock.method(HostTools.prototype, 'closeBrowser', async () => {
    closed++;
  });
  transport.onCancel = () => {
    throw new Error('Fixture cancellation failure');
  };
  await fixture.rootListeners[0]!();
  assert.equal(closed, 2);
  assert.match(host.status()!.error, /Fixture cancellation failure/);
  assert.equal(host.status()!.busy, false);
  transport.onCancel = () => {};
});

for (const loss of ['removed', 'replaced', 'trust'] as const)
  test(`workspace root ${loss} cannot publish an in-flight connection`, async (context) => {
    const host = await setup(context);
    const roots = fixture.roots;
    const start = OmpClient.prototype.start;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mocked = context.mock.method(
      OmpClient.prototype,
      'start',
      async function (this: OmpClient, options: Parameters<OmpClient['start']>[0]) {
        await start.call(this, options);
        await new Promise<void>((resolve) => {
          release = resolve;
          entered();
        });
      },
    );
    const connecting = host.request({ type: 'connect' });
    void connecting.catch(() => {});
    await started;
    try {
      if (loss === 'trust') fixture.trusted = false;
      else
        fixture.roots =
          loss === 'removed'
            ? []
            : [{ ...roots[0]!, uri: Uri.file(path.join(host.root, 'replacement')) }];
      await fixture.rootListeners[0]!();
      release();
      await assert.rejects(connecting, /workspace/);
      assert.equal(host.status()!.connected, false);
      assert.equal(host.status()!.connecting, false);
      assert.deepEqual(host.storedState!().sessions, []);
      assert.deepEqual(host.storedState!().changes, []);
      mocked.mock.restore();
      fixture.roots = roots;
      fixture.trusted = true;
      await host.request({ type: 'connect' });
      assert.equal(host.status()!.connected, true);
    } finally {
      release();
      await Promise.allSettled([connecting]);
    }
  });

test('connection diagnostics reach OMP output without becoming conversation content', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const diagnostic = 'Fixture startup diagnostic';
  transport.client!.log(diagnostic);
  assert.ok(fixture.logs.some((entry) => entry.includes(diagnostic)));
  assert.equal(JSON.stringify(host.status()).includes(diagnostic), false);
  assert.equal(JSON.stringify(host.storedState!()).includes(diagnostic), false);
});

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
              options: [],
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
          : /No OMP models are available.*\/login/,
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

for (const action of ['deactivation', 'disconnect'])
  test(
    `${action} stops upstream before local cleanup and records cancellation without replay`,
    { timeout: 5000 },
    async (context) => {
      const host = await setup(context);
      await host.request({ type: 'connect' });
      const { started, release, hold } = promptPause();
      const events: string[] = [];
      let sent = 0;
      transport.onPrompt = async () => {
        sent++;
        await hold();
        throw new Error('Owned child stopped');
      };
      context.mock.method(transport.client!, 'stop', async (immediate?: boolean) => {
        if (!events.length) assert.equal(Boolean(immediate), action === 'deactivation');
        events.push('stop');
        transport.client!.connected = false;
        release();
      });
      const finish = HostTools.prototype.finish;
      context.mock.method(
        HostTools.prototype,
        'finish',
        async function (this: InstanceType<typeof HostTools>) {
          events.push('cleanup');
          assert.equal(events[0], 'stop');
          await finish.call(this);
        },
      );
      const pending = host.request({ type: 'prompt', text: 'Interrupted on reload' });
      await started;
      await host.request({ type: 'queuePrompt', text: 'Must not replay' });
      const { deactivate } = await import('../extension.js');
      await Promise.all([
        action === 'deactivation' ? deactivate() : host.request({ type: 'disconnect' }),
        pending,
      ]);
      assert.equal(sent, 1);
      assert.equal(events[0], 'stop');
      assert.ok(events.includes('cleanup'));
      assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
      assert.equal(host.status()!.connected, false);
      assert.deepEqual(host.status()!.queued, []);
      assert.deepEqual(host.storedState!().changes, []);
    },
  );

test('Stop sends upstream cancellation before releasing local held tools', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const { started, release, hold } = promptPause();
  const events: string[] = [];
  transport.onPrompt = async () => {
    await hold();
    throw new Error('Owned prompt stopped');
  };
  transport.onCancel = () => {
    events.push('cancel');
    release();
  };
  const finish = HostTools.prototype.finish;
  context.mock.method(
    HostTools.prototype,
    'finish',
    async function (this: InstanceType<typeof HostTools>) {
      events.push('cleanup');
      assert.equal(events[0], 'cancel');
      await finish.call(this);
    },
  );
  const pending = host.request({ type: 'prompt', text: 'Hold without provider continuation' });
  await started;
  await host.request({ type: 'queuePrompt', text: 'Must not replay' });
  await Promise.all([host.request({ type: 'cancel' }), pending]);
  assert.equal(events[0], 'cancel');
  assert.ok(events.includes('cleanup'));
  assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
  assert.equal(host.status()!.connected, true);
  assert.deepEqual(host.status()!.queued, []);
});

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
