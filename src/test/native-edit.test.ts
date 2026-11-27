import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationBroker } from '../mutations.js';
import type { Mutation } from '../mutations.js';
import * as runtime from './native-edit-fixture.js';
import type { NativeEditApi } from '../native-edit.js';
import type { EditStore } from '@oh-my-pi/pi-natives';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { installNativeEdit } = await import('../native-edit.js');

async function setup(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-native-unit-'));
  const artifacts = path.join(root, 'private');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  process.env.VS_OMP_ARTIFACTS_ROOT = artifacts;
  context.after(async () => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  type Handler = (...args: any[]) => any;
  const handlers = new Map<string, Handler>();
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (definition: typeof tool) => {
      tool = definition;
    },
  } as unknown as NativeEditApi;
  await installNativeEdit(
    api,
    runtime as unknown as NonNullable<Parameters<typeof installNativeEdit>[1]>,
  );
  const source = path.join(root, 'file.txt');
  await writeFile(source, 'before');
  const native = { cwd: root, sessionManager: { getSessionId: () => 'durable' } };
  const results: Mutation[] = [];
  const broker = new MutationBroker(
    path.join(artifacts, 'mutations'),
    async (mutation) => {
      results.push(mutation);
      return null;
    },
    new AbortController().signal,
  );
  await broker.start();
  context.after(() => broker.close());
  const event = {
    toolCallId: randomUUID(),
    toolName: 'read',
    input: { path: source },
    content: [{ type: 'text', text: 'before' }, { type: 'image' }],
    isError: false,
  };
  await handlers.get('tool_result')!(event, native);
  const execute = async (plan: object) => {
    const id = randomUUID();
    const input = { input: JSON.stringify({ path: source, ...plan }) };
    await handlers.get('tool_call')!({ toolName: 'edit', toolCallId: id, input }, native);
    try {
      return (await tool.execute(id, input, undefined, undefined, native)) as { isError: boolean };
    } finally {
      await handlers.get('tool_result')!({ ...event, toolName: 'edit', toolCallId: id }, native);
    }
  };
  return { root, source, native, handlers, event, execute, results, tool, api };
}

test('native adapter captures write/delete/move without granting the parser filesystem ownership', async (context) => {
  const current = await setup(context);
  assert.equal(current.tool.parameters.type, 'object');
  assert.deepEqual(current.tool.parameters.required, ['input']);
  assert.equal(
    (current.tool.parameters.properties as Record<string, { type: string }>).input!.type,
    'string',
  );
  const readOnly = path.join(current.root, '.omp/agent/sessions/local.md');
  await mkdir(path.dirname(readOnly), { recursive: true });
  await writeFile(readOnly, 'readable but not editable');
  await current.handlers.get('tool_result')!(
    { ...current.event, input: { path: readOnly } },
    current.native,
  );
  await current.handlers.get('tool_result')!(
    { ...current.event, input: { path: `${current.source}:1-1` } },
    current.native,
  );
  for (const plan of [
    { op: 'update', content: 'after' },
    { op: 'delete' },
    { op: 'move', content: 'after move', moveTo: path.join(current.root, 'destination.txt') },
  ])
    assert.equal((await current.execute(plan)).isError, false);
  assert.deepEqual(
    current.results.map((mutation) => mutation.op),
    ['write', 'delete', 'move'],
  );
  for (const mutation of current.results)
    assert.equal('before' in mutation && mutation.before, 'before');
  await current.handlers.get('tool_result')!(
    { ...current.event, toolName: 'write' },
    current.native,
  );
  await current.handlers.get('tool_result')!(
    { ...current.event, toolName: 'todo' },
    current.native,
  );
  await current.handlers.get('tool_call')!({ toolName: 'read' }, current.native);
  await current.handlers.get('tool_result')!(
    { ...current.event, toolName: 'edit', isError: true },
    current.native,
  );
  for (const event of ['session_tree', 'session_switch', 'session_shutdown'])
    current.handlers.get(event)!();
});

test('native adapter refuses stale, aliased, uncaptured, malformed and partially failed plans', async (context) => {
  const current = await setup(context);
  for (const plan of [
    { op: 'update', paths: [] },
    { op: 'update', requestPath: '/uncaptured.txt', content: 'bad' },
    { op: 'update' },
    { op: 'unknown', content: 'bad' },
    { op: 'move', content: 'bad' },
    { op: 'update', content: 'bad', error: 'after' },
    { op: 'update', error: 'callback' },
  ]) {
    await current.handlers.get('tool_result')!(current.event, current.native);
    await assert.rejects(current.execute(plan));
  }
  await current.handlers.get('tool_result')!(current.event, current.native);
  assert.equal((await current.execute({ op: 'update', error: 'before' })).isError, true);
  await writeFile(current.source, 'newer');
  await assert.rejects(current.execute({ op: 'update', content: 'bad' }), /saved file/);
  const alias = path.join(current.root, 'alias.txt');
  await symlink(current.source, alias);
  await assert.rejects(current.execute({ path: alias, op: 'delete' }), /symbolic-link/);
  const missing = path.join(current.root, 'missing.txt');
  assert.equal(
    (await current.execute({ path: missing, op: 'create', content: 'new' })).isError,
    false,
  );
  await mkdir(path.join(current.root, 'directory.txt'));
  await assert.rejects(
    current.execute({ path: path.join(current.root, 'directory.txt'), op: 'delete' }),
  );
  assert.equal(current.results.length, 1);
  await installNativeEdit(current.api);
});

test('recoverable native edit errors retain the read snapshot for the documented retry', async (context) => {
  const current = await setup(context);
  assert.equal((await current.execute({ op: 'update', error: 'before' })).isError, true);
  const retried = await current.execute({ op: 'update', content: 'after' });
  assert.equal(retried.isError, false);
  assert.deepEqual(
    current.results.map((mutation) => [
      mutation.op,
      'content' in mutation ? mutation.content : null,
    ]),
    [['write', 'after']],
  );
});

test('read results record a snapshot without a line-0 provenance sentinel', async (context) => {
  const current = await setup(context);
  runtime.recordedSnapshots.length = 0;
  await current.handlers.get('tool_result')!(current.event, current.native);
  assert.deepEqual(
    runtime.recordedSnapshots.map(({ seenLines }) => seenLines),
    [undefined],
  );
});

test('edit waits for an unawaited read result before preparing the snapshot', async (context) => {
  const current = await setup(context);
  current.handlers.get('session_switch')!();
  const reading = current.handlers.get('tool_result')!(current.event, current.native);
  const result = await current.execute({ op: 'update', content: 'after' });
  assert.equal(result.isError, false);
  await reading;
  assert.equal(current.results.length, 1);
});

test('edit prefers the shared OMP store over the private snapshot store', async (context) => {
  const current = await setup(context);
  const shared = new runtime.EditStore();
  shared.recordSnapshotFile(current.source);
  current.api.pi = { getEditStore: () => shared as unknown as EditStore };
  current.handlers.get('session_switch')!();
  const result = await current.execute({ op: 'update', content: 'after' });
  assert.equal(result.isError, false);
  assert.equal(shared.headText(current.source), 'before');
});

test('invalid read paths and shared-store failures do not poison later edits', async (context) => {
  const current = await setup(context);
  await current.handlers.get('tool_result')!(
    { ...current.event, input: { path: 'https://example.com/file' } },
    current.native,
  );
  current.api.pi = {
    getEditStore: () => {
      throw new Error('shared store unavailable');
    },
  };
  const result = await current.execute({ op: 'update', content: 'after' });
  assert.equal(result.isError, false);
  assert.equal(current.results.length, 1);
});

test('a fresh read refreshes a stale snapshot after an external change', async (context) => {
  const current = await setup(context);
  await writeFile(current.source, 'newer');
  await current.handlers.get('tool_result')!(current.event, current.native);
  const result = await current.execute({ op: 'update', content: 'after' });
  assert.equal(result.isError, false);
  const mutation = current.results.at(-1)!;
  if (mutation.op !== 'write') assert.fail('expected a write mutation');
  assert.equal(mutation.before, 'newer');
});
