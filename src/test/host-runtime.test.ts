import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  agentRuntimeEnvironment,
  resetRuntimeCache,
  type NodeRuntimeMode,
} from '../host-runtime.js';

const execute = promisify(execFile);

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linewise-runtime-'));
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(root, 'private');
  resetRuntimeCache();
  context.after(async () => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
    resetRuntimeCache();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function value(environment: Array<{ name: string; value: string }>, name: string) {
  return environment.find((entry) => entry.name === name)?.value;
}

test('auto uses the host Node shim when the workspace declares a modern major', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, '.nvmrc'), '24\n');
  const environment = agentRuntimeEnvironment('auto', root);
  const pathValue = value(environment, 'PATH');
  assert.ok(pathValue);
  const shim = pathValue.split(path.delimiter)[0]!;
  assert.equal(shim, path.join(process.env.VS_OMP_ARTIFACTS_ROOT!, 'runtime'));
  assert.equal(value(environment, 'LINEWISE_NODE'), process.execPath);
  assert.equal(value(environment, 'LINEWISE_NODE_VERSION'), process.versions.node);
  assert.match(await readFile(path.join(shim, 'node'), 'utf8'), /ELECTRON_RUN_AS_NODE=1/);
  const result = await execute(path.join(shim, 'node'), ['-p', 'process.versions.node']);
  assert.equal(result.stdout.trim(), process.versions.node);
});

test('auto keeps the system runtime without a declaration and system always does', async (context) => {
  const root = await fixture(context);
  assert.equal(value(agentRuntimeEnvironment('auto', root), 'PATH'), undefined);
  await writeFile(path.join(root, '.nvmrc'), '24\n');
  assert.equal(value(agentRuntimeEnvironment('system', root), 'PATH'), undefined);
});

test('package engines can select the host runtime', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));
  assert.ok(value(agentRuntimeEnvironment('auto', root), 'PATH'));
});

test('host mode selects the shim regardless of workspace declarations', async (context) => {
  const root = await fixture(context);
  assert.ok(value(agentRuntimeEnvironment('host' as NodeRuntimeMode, root), 'PATH'));
});
