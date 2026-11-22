import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { CommandPermissions } = await import('../host-permissions.js');
const { HostTools } = await import('../host-tools.js');
beforeEach(reset);

function permissions() {
  let idle = true;
  return {
    controller: new CommandPermissions(() => {
      if (!fixture.trusted || !idle) throw new Error('Not idle and trusted');
    }),
    busy: () => {
      idle = false;
    },
  };
}

test('YOLO requires its own confirmation, has an explicit warning and never becomes a default', async () => {
  const { controller } = permissions();
  fixture.quickPick = 'yolo';
  await controller.pick();
  assert.equal(controller.value, 'rules');
  fixture.approval = 'Enable Allow All';
  await controller.pick();
  assert.equal(controller.value, 'rules');
  fixture.approval = 'Enable YOLO';
  await controller.pick();
  assert.equal(controller.value, 'yolo');
  const warning = fixture.warnings.at(-1)!;
  assert.match(warning.detail!, /without an OS sandbox/);
  assert.match(warning.detail!, /cannot reliably detect/);
  assert.match(warning.detail!, /File review.*Stop stay unchanged/);
  const count = fixture.warnings.length;
  await controller.pick();
  assert.equal(fixture.warnings.length, count);
  controller.reset();
  assert.equal(controller.value, 'rules');
  for (const mode of ['all', 'yolo']) {
    fixture.configuration.set('omp.permissions.defaultMode', mode);
    assert.throws(() => permissions());
  }
});

test('Allow All to YOLO requires a second confirmation and restrictions can be restored', async () => {
  const { controller } = permissions();
  fixture.quickPick = 'all';
  fixture.approval = 'Enable Allow All';
  await controller.pick();
  fixture.quickPick = 'yolo';
  await controller.pick();
  assert.equal(controller.value, 'all');
  fixture.approval = 'Enable YOLO';
  await controller.pick();
  assert.equal(controller.value, 'yolo');
  fixture.quickPick = 'ask';
  await controller.pick();
  assert.equal(controller.value, 'ask');
});

test('reset and a newer picker retire late YOLO confirmations', async () => {
  for (const newer of ['reset', 'ask']) {
    const { controller } = permissions();
    let allow!: (answer: string) => void;
    let shown!: () => void;
    const displayed = new Promise<void>((resolve) => {
      shown = resolve;
    });
    fixture.quickPick = 'yolo';
    fixture.onWarning = () => {
      shown();
      return new Promise<string>((resolve) => {
        allow = resolve;
      });
    };
    const pending = controller.pick();
    await displayed;
    if (newer === 'reset') controller.reset();
    else {
      fixture.quickPick = 'ask';
      await controller.pick();
    }
    allow('Enable YOLO');
    await pending;
    assert.equal(controller.value, newer === 'reset' ? 'rules' : 'ask');
    fixture.onWarning = undefined;
  }
});

test('trust loss or operation startup before confirmation cannot grant YOLO', async () => {
  for (const change of ['trust', 'busy']) {
    const { controller, busy } = permissions();
    let allow!: (answer: string) => void;
    let shown!: () => void;
    const displayed = new Promise<void>((resolve) => {
      shown = resolve;
    });
    fixture.quickPick = 'yolo';
    fixture.onWarning = () => {
      shown();
      return new Promise<string>((resolve) => {
        allow = resolve;
      });
    };
    const pending = controller.pick();
    await displayed;
    if (change === 'trust') fixture.trusted = false;
    else busy();
    const rejected = assert.rejects(pending, /Not idle and trusted/);
    allow('Enable YOLO');
    await rejected;
    assert.equal(controller.value, 'rules');
    reset();
  }
});

test('YOLO executes owned shell compositions without approval but preserves command restrictions', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-host-yolo-'));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
  );
  context.after(async () => {
    await tools.finish();
    await rm(cwd, { recursive: true, force: true });
  });
  fixture.quickPick = 'yolo';
  fixture.approval = 'Enable YOLO';
  await tools.pickPermissions();
  assert.equal(tools.permissions, 'yolo');
  const sessionId = 'native';
  tools.begin({
    sessionId,
    owner: 'local',
    cwd,
    signal: new AbortController().signal,
    valid: () => true,
  });
  const owned = {
    sessionId,
    ...(await tools.create({
      sessionId,
      command: '/bin/bash',
      args: ['-c', 'printf yolo > yolo.txt; cat yolo.txt'],
    })),
  };
  assert.equal((await tools.waitForExit(owned)).exitCode, 0);
  assert.equal(await readFile(path.join(cwd, 'yolo.txt'), 'utf8'), 'yolo');
  assert.equal(fixture.warnings.length, 1);
  await assert.rejects(
    tools.create({ sessionId, command: '/sbin/wipefs', args: ['--help'] }),
    /YOLO safety restriction/,
  );
  fixture.configuration.set('omp.permissions.commandRules', [
    { command: ['echo'], action: 'deny' },
  ]);
  await assert.rejects(tools.create({ sessionId, command: '/bin/echo' }), /blocked/);
  await tools.finish();
  tools.resetPermissions();
  assert.equal(tools.permissions, 'rules');
});
