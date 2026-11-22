import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { notebookRequest } from '../notebook-policy.js';
import { installNativeNotebook } from '../native-notebook.js';
import type { NativeEditApi } from '../native-edit.js';
import { Document, fixture, reset, seedFile, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const vscode = await import('vscode');
const { editNotebook } = await import('../host-notebook.js');
const { guardReason } = await import('../omp-guard.js');
const { WorkspaceFiles } = await import('../workspace.js');
const { HostTools } = await import('../host-tools.js');
const { ReviewJournal, PathGuard } = await import('../review.js');

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-notebook-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  const target = path.join(cwd, 'saved.ipynb');
  const before = JSON.stringify({
    nbformat: 4,
    metadata: { retained: true },
    cells: [
      { cell_type: 'code', source: ['old\n'], metadata: {}, outputs: [], execution_count: null },
    ],
  });
  await writeFile(target, before);
  seedFile(target, before);
  const document = new Document(Uri.file(target), before);
  document.isDirty = false;
  fixture.documents.push(document);
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const scope = { cwd, privateRoot, signal: abort.signal, valid: () => true };
  const input = notebookRequest.parse({
    path: target,
    cell: 1,
    expectedSource: 'old\n',
    source: 'new\n',
  });
  context.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, target, privateRoot, before, input, document, abort, scope };
}

test('notebook host validates format authority, exact source and saved workspace ownership before writes', async (context) => {
  const current = await setup(context);
  const writes: unknown[] = [];
  const invoke = (change = {}) =>
    editNotebook({ ...current.input, ...change }, current.scope, async (image) => {
      writes.push(image);
    });
  assert.equal(guardReason({ toolName: 'notebook_edit', input: current.input }), undefined);
  assert.match(
    guardReason({ toolName: 'notebook_edit', input: { ...current.input, kernel: 'python' } })!,
    /Invalid bounded notebook/,
  );
  await assert.rejects(invoke({ expectedSource: 'stale' }), /stale/);
  await assert.rejects(invoke({ path: 'other.json' }));
  await assert.rejects(invoke({ path: '/outside.ipynb' }));
  await assert.rejects(invoke({ path: path.join(current.privateRoot, 'hidden.ipynb') }));
  fixture.notebook = { uri: Uri.file(current.target), isDirty: true };
  await assert.rejects(invoke(), /dirty notebook/);
  fixture.notebook = undefined;
  current.document.isDirty = true;
  await assert.rejects(invoke(), /Save notebook edit targets/);
  current.document.isDirty = false;
  await assert.rejects(
    invoke({ source: current.input.expectedSource }),
    /no supported text changes/,
  );
  assert.equal(writes.length, 0);
  assert.equal(fixture.commandCalls.length, 0);
  const result = JSON.parse(await invoke());
  assert.equal(result.completed, 1);
  assert.equal(result.review, 'pending');
  assert.equal(writes.length, 1);
  assert.equal(current.document.getText(), current.before);
});

test('Stop releases a stalled notebook capture and late file reads cannot write', async (context) => {
  const current = await setup(context);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = vscode.workspace.fs.readFile;
  context.mock.method(vscode.workspace.fs, 'readFile', async (...args: Parameters<typeof read>) => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return read(...args);
  });
  let writes = 0;
  const pending = editNotebook(current.input, current.scope, async () => {
    writes++;
  });
  const rejected = assert.rejects(pending, /Stopped notebook capture/);
  await started;
  current.abort.abort(new Error('Stopped notebook capture'));
  await rejected;
  release();
  await assert.rejects(
    editNotebook(current.input, current.scope, async () => {
      writes++;
    }),
    /Stopped/,
  );
  assert.equal(writes, 0);
  assert.equal(current.document.getText(), current.before);
});

function nativeTool() {
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  const handlers = new Map<string, (...args: any[]) => any>();
  installNativeNotebook({
    registerTool: (value) => {
      tool = value;
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
  } as NativeEditApi);
  return { tool, handlers };
}

test('registered notebook tool uses exact one-use permission and durable recoverable provenance', async (context) => {
  const current = await setup(context);
  const { tool, handlers } = nativeTool();
  assert.equal(tool.approval, 'write');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const id = randomUUID();
  const native = { cwd: current.cwd, sessionManager: { getSessionId: () => 'native' } };
  const execute = () => tool.execute(id, current.input, current.scope.signal, undefined, native);
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = current.privateRoot;
  const files = new WorkspaceFiles(Uri.file(current.cwd) as any);
  let persisted = '[]';
  const journal = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async (changes) => {
      persisted = JSON.stringify(changes);
    },
  );
  const tools = new HostTools(files, journal, path.join(current.privateRoot, 'mutations'));
  await tools.run(
    { ...current.scope, sessionId: 'native', owner: 'local', turnId: 'turn' },
    async () => {
      await handlers.get('tool_call')!({ toolName: 'other' });
      await handlers.get('tool_result')!({ toolName: 'other' });
      await handlers.get('tool_call')!({
        toolName: 'notebook_edit',
        toolCallId: id,
        input: current.input,
      });
      const permission = {
        sessionId: 'native',
        toolCall: { toolCallId: id, rawInput: current.input },
        options: [{ kind: 'allow_once', optionId: 'once', name: 'Allow Once' }],
      };
      assert.deepEqual(await tools.permission(permission as any), {
        outcome: { outcome: 'selected', optionId: 'once' },
      });
      const result = (await execute()) as { content: { text: string }[] };
      assert.equal(JSON.parse(result.content[0]!.text).completed, 1);
      assert.deepEqual(await tools.permission(permission as any), {
        outcome: { outcome: 'cancelled' },
      });
      await handlers.get('tool_result')!({ toolName: 'notebook_edit', toolCallId: id });
    },
  );
  const reopened = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async () => {},
    JSON.parse(persisted),
  );
  const change = reopened.list()[0]!;
  assert.equal(change.operations![0]!.tool, 'notebook_edit');
  assert.equal(change.operations![0]!.toolCallId, id);
  await reopened.discard(change.id);
  assert.equal(await files.read(current.target), current.before);
  await assert.rejects(
    tool.execute(id, current.input, AbortSignal.abort(new Error('Stopped')), undefined, native),
    /Stopped/,
  );
});

test('Stop after durable notebook intent prevents the write and recovery retires unapplied intent', async (context) => {
  const current = await setup(context);
  const files = new WorkspaceFiles(Uri.file(current.cwd) as any);
  let persisted = '[]';
  const journal = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async (changes) => {
      persisted = JSON.stringify(changes);
      if (changes.length) current.abort.abort(new Error('Stopped after notebook intent'));
    },
  );
  await assert.rejects(
    editNotebook(current.input, current.scope, (image) =>
      journal.write('session', image.path, image.content, current.scope.signal, image.before),
    ),
    /Stopped after notebook intent/,
  );
  assert.equal(await files.read(current.target), current.before);
  const reopened = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async () => {},
    JSON.parse(persisted),
  );
  await reopened.refresh();
  assert.deepEqual(reopened.list(), []);
});
