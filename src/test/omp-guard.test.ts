import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationBroker } from '../mutations.js';
import type { GuardEvent } from '../omp-guard.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
// omp-guard imports vscode, so it must load after the test loader is registered.
const { default: installGuard } = await import('../omp-guard.js');

async function directoryReads(directory: string, read: (target: string) => Promise<unknown>) {
  await mkdir(path.join(directory, 'folder.txt'));
  await writeFile(path.join(directory, 'folder.txt', 'nested.bin'), 'arbitrary text extension');
  await writeFile(path.join(directory, 'binary.bin'), 'not an admitted mutation type');
  await mkdir(path.join(directory, '.omp/agent/sessions'), { recursive: true });
  await writeFile(path.join(directory, '.omp/agent/sessions/local.md'), 'workspace-owned history');
  for (const target of [
    '.',
    directory,
    `${directory}/`,
    'folder.txt',
    'binary.bin',
    'folder.txt/nested.bin:1-2',
    '.omp/agent/sessions/local.md',
  ])
    assert.equal(await read(target), undefined);
  await symlink(path.dirname(directory), path.join(directory, 'outside'));
  for (const target of ['private', 'alias.txt', 'outside', path.dirname(directory)])
    assert.ok(await read(target));
}

type ToolGuard = (
  event: GuardEvent,
  context: { cwd: string },
) => Promise<{ block: true; reason: string } | undefined>;

async function scopedShell(directory: string, guard: ToolGuard) {
  const invoke = (target: string) =>
    guard({ toolName: 'read', input: { path: target } }, { cwd: directory });
  const call = {
    toolName: 'bash',
    toolCallId: `call_${randomUUID()}|${'opaque/+'.repeat(70)}`,
    input: { command: 'true' },
  };
  assert.equal((await guard(call, { cwd: directory }))?.block, true);
  let redirect: (() => Promise<void>) | undefined;
  const broker = new MutationBroker(
    path.join(directory, 'private', 'mutations'),
    async () => {
      await redirect?.();
      return null;
    },
    new AbortController().signal,
  );
  await broker.start();
  try {
    assert.equal(await invoke(path.dirname(directory)), undefined);
    redirect = async () => {
      await rm(path.join(directory, 'outside'));
      await symlink(directory, path.join(directory, 'outside'));
    };
    assert.match((await invoke('outside'))!.reason, /changed after approval/);
    redirect = undefined;
    assert.equal(await guard(call, { cwd: directory }), undefined);
    assert.equal(await broker.permit(call.toolCallId, JSON.stringify(call.input)), true);
    assert.equal(
      (await guard({ ...call, toolCallId: undefined }, { cwd: directory }))?.block,
      true,
    );
    assert.equal(
      await guard(
        { toolName: 'edit', input: { input: '[normal.txt#ABCD]\nREM' } },
        { cwd: directory },
      ),
      undefined,
    );
  } finally {
    await broker.close();
  }
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  assert.equal((await guard(call, { cwd: directory }))?.block, true);
}

test('installed guard pins tools and refuses private artifacts, symlink aliases and invalid reads', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omp-guard-'));
  const original = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(async () => {
    if (original === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = original;
    await rm(directory, { recursive: true, force: true });
  });
  const artifacts = path.join(directory, 'private');
  await mkdir(artifacts);
  process.env.VS_OMP_ARTIFACTS_ROOT = artifacts;
  let start!: () => Promise<void>;
  let guard!: (
    event: GuardEvent,
    context: { cwd: string },
  ) => Promise<{ block: true; reason: string } | undefined>;
  let tools: string[] = [];
  await installGuard(
    {
      registerTool: () => {},
      registerCommand: () => {},
      appendEntry: () => {},
      on: (event, handler) => {
        if (event === 'session_start') start = handler as typeof start;
        else guard = handler as typeof guard;
      },
      setActiveTools: async (names) => {
        tools = names;
      },
    },
    async () => {},
  );
  await start();
  assert.deepEqual(
    tools,
    'read,write,todo,retain,recall,memory_edit,edit,bash,editor,ask,browser,rename,task,fetch,code_action,notebook_edit'.split(
      ',',
    ),
  );
  const invoke = (toolName: string, target: string) =>
    guard({ toolName, input: { path: target, content: 'text' } }, { cwd: directory });
  await writeFile(path.join(artifacts, 'history.txt'), 'private');
  await symlink(path.join(artifacts, 'history.txt'), path.join(directory, 'alias.txt'));
  for (const target of ['private/history.txt', 'alias.txt', '.omp/agent/sessions/internal.txt'])
    assert.equal((await invoke('write', target))?.block, true);
  await writeFile(path.join(directory, 'normal.txt'), 'text');
  assert.equal(await invoke('read', 'normal.txt'), undefined);
  await directoryReads(directory, (target) => invoke('read', target));
  await writeFile(path.join(directory, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal(await invoke('read', 'large.txt'), undefined);
  assert.equal((await invoke('bash', 'normal.txt'))?.block, true);
  assert.equal(await invoke('todo', ''), undefined);
  await scopedShell(directory, guard);
  assert.equal((await invoke('write', 'normal.txt'))?.block, true);
});
