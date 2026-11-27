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

test('elevated permission modes require explicit confirmation and never become defaults', () => {
  const { controller } = permissions();
  assert.equal(controller.value, 'rules');
  assert.throws(() => controller.set('all'), /explicit confirmation/);
  assert.throws(() => controller.set('yolo'), /explicit confirmation/);
  controller.set('all', true);
  assert.equal(controller.value, 'all');
  controller.set('all');
  assert.equal(controller.value, 'all');
  controller.set('yolo', true);
  assert.equal(controller.value, 'yolo');
  controller.set('rules');
  assert.equal(controller.value, 'rules');
  controller.reset();
  assert.equal(controller.value, 'rules');
  for (const mode of ['all', 'yolo']) {
    fixture.configuration.set('omp.permissions.defaultMode', mode);
    assert.throws(() => permissions());
  }
});

test('permission changes fail closed when untrusted or while a prompt owns cleanup', () => {
  const trusted = permissions();
  fixture.trusted = false;
  assert.throws(() => trusted.controller.set('ask'), /Not idle and trusted/);
  reset();
  const { controller, busy } = permissions();
  busy();
  assert.throws(() => controller.set('yolo', true), /Not idle and trusted/);
  assert.equal(controller.value, 'rules');
});

test('the configured default is the only persisted permission state', () => {
  fixture.configuration.set('omp.permissions.defaultMode', 'ask');
  const { controller } = permissions();
  assert.equal(controller.value, 'ask');
  controller.set('all', true);
  controller.reset();
  assert.equal(controller.value, 'ask');
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
  tools.setPermissions('yolo', true);
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
  assert.equal(fixture.warnings.length, 0);
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
