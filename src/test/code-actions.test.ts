import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeActionRequest } from '../code-action-policy.js';
import { installNativeCodeActions } from '../native-code-actions.js';
import type { NativeEditApi } from '../native-edit.js';
import { randomUUID } from 'node:crypto';
import type { RenameImage } from '../host-rename.js';
import { fixture, reset, seedFile, Document, Uri, Range, Position } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { guardReason } = await import('../omp-guard.js');
const { codeActionsWorkspace } = await import('../host-code-actions.js');
const { HostTools } = await import('../host-tools.js');
const { WorkspaceFiles } = await import('../workspace.js');
const { ReviewJournal, PathGuard } = await import('../review.js');
const { isRefactorInvocation, isStoppedRefactorResult } = await import('./live-code-actions.js');

test('refactor Stop hold accepts only explicit discovery of the exact refactor kind', () => {
  const context = {
    diagnostics: [],
    triggerKind: 1,
    only: { value: 'refactor.rewrite.export.default' },
  };
  assert.equal(isRefactorInvocation(context), true);
  assert.equal(isRefactorInvocation({ ...context, triggerKind: 2 }), false);
  assert.equal(isRefactorInvocation({ ...context, only: undefined }), false);
  assert.equal(isRefactorInvocation({ ...context, only: { value: 'refactor' } }), false);
});

test('refactor Stop evidence accepts only the exact structured runtime interruption', () => {
  const result = {
    name: 'code_action',
    content: JSON.stringify([{ type: 'text', text: 'Interrupted by user' }]),
  };
  assert.equal(isStoppedRefactorResult(result), true);
  assert.equal(isStoppedRefactorResult({ ...result, name: 'read' }), false);
  assert.equal(
    isStoppedRefactorResult({
      ...result,
      content: JSON.stringify([{ type: 'text', text: 'Failed to cancel service' }]),
    }),
    false,
  );
  assert.equal(isStoppedRefactorResult({ ...result, content: '[]' }), false);
});

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-code-action-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  const documents: Document[] = [];
  for (const name of ['main.ts', 'other.ts', 'private/secret.ts']) {
    const target = path.join(cwd, name);
    await writeFile(target, 'const rate = 7;\n');
    seedFile(target, 'const rate = 7;\n');
    const document = new Document(Uri.file(target), 'const rate = 7;\n');
    document.isDirty = false;
    documents.push(document);
    fixture.documents.push(document);
  }
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const input = {
    action: 'list',
    path: 'main.ts',
    line: 1,
    column: 7,
    endLine: 1,
    endColumn: 11,
    kind: 'quickfix',
    title: null,
    paths: ['main.ts', 'other.ts'],
  };
  const entries = documents
    .slice(0, 2)
    .map((document) => [
      document.uri,
      [{ range: new Range(new Position(0, 6), new Position(0, 10)), newText: 'price' }],
    ]);
  const action = {
    title: 'Fix rate',
    kind: { value: 'quickfix' },
    edit: { size: 2, entries: () => entries },
  };
  fixture.commands.set('vscode.executeCodeActionProvider', () => [action]);
  const abort = new AbortController();
  const scope = { cwd, privateRoot, signal: abort.signal, valid: () => true };
  const writes: RenameImage[] = [];
  const invoke = (change: object = {}) =>
    codeActionsWorkspace(codeActionRequest.parse({ ...input, ...change }), scope, async (image) => {
      writes.push(image);
    });
  context.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, input, action, scope, documents, abort, writes, invoke };
}

test('code action schema fixes mode, title, range, kind and capture authority', () => {
  const input = {
    action: 'list',
    path: 'a.ts',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
    kind: 'refactor',
    title: null,
    paths: ['a.ts'],
  };
  assert.equal(codeActionRequest.safeParse(input).success, true);
  assert.equal(guardReason({ toolName: 'code_action', input }), undefined);
  assert.notEqual(guardReason({ toolName: 'editor', input }), undefined);
  assert.equal(
    guardReason({
      toolName: 'code_action',
      input: { ...input, kind: 'refactor.rewrite.export.default' },
    }),
    undefined,
  );
  for (const change of [
    { action: 'apply' },
    { title: 'unexpected' },
    { title: '\0' },
    { line: 0 },
    { endColumn: 0 },
    { line: 2 },
    { kind: 'arbitrary' },
    { paths: [] },
    { paths: Array(9).fill('a.ts') },
    { command: 'arbitrary' },
  ]) {
    assert.equal(codeActionRequest.safeParse({ ...input, ...change }).success, false);
    assert.match(
      guardReason({ toolName: 'code_action', input: { ...input, ...change } })!,
      /Invalid bounded code action/,
    );
  }
});

test('code actions list bounded metadata without forwarding commands or edits', async (context) => {
  const current = await setup(context);
  const result = JSON.parse(await current.invoke());
  assert.deepEqual(result, {
    actions: [
      {
        title: 'Fix rate',
        kind: 'quickfix',
        available: true,
        disabled: false,
        commandIgnored: false,
      },
    ],
    untrusted: true,
    textOnly: true,
  });
  assert.equal(current.writes.length, 0);
  assert.deepEqual(fixture.commandCalls[0]!.args.slice(1), [
    new Range(new Position(0, 6), new Position(0, 10)),
    'quickfix',
    32,
  ]);
  fixture.commands.set('vscode.executeCodeActionProvider', () => undefined);
  assert.deepEqual(JSON.parse(await current.invoke()).actions, []);
});

test('selected code action copies only captured text postimages into review', async (context) => {
  const current = await setup(context);
  const result = JSON.parse(await current.invoke({ action: 'apply', title: 'Fix rate' }));
  assert.deepEqual(result.files, ['main.ts', 'other.ts']);
  assert.equal(result.completed, 2);
  assert.equal(result.review, 'pending');
  assert.ok(
    current.writes.every(
      (image) => image.before === 'const rate = 7;\n' && image.content === 'const price = 7;\n',
    ),
  );
  assert.equal(current.documents[0]!.getText(), 'const rate = 7;\n');
});

test('function extraction is explicit while move actions remain unavailable despite text entries', async (context) => {
  const current = await setup(context);
  for (const kind of ['refactor.move', 'refactor.move.file', 'refactor.move.newFile']) {
    fixture.commands.set('vscode.executeCodeActionProvider', () => [
      { ...current.action, kind: { value: kind } },
    ]);
    const listed = JSON.parse(await current.invoke({ kind: 'refactor' })).actions[0];
    assert.equal(listed.available, false);
    assert.equal(listed.unavailableReason, 'resource-operations-uninspectable');
    await assert.rejects(
      current.invoke({ kind: 'refactor', action: 'apply', title: 'Fix rate' }),
      /resource operations/,
    );
  }
  assert.equal(current.writes.length, 0);
  fixture.commands.set('vscode.executeCodeActionProvider', () => [
    { ...current.action, kind: { value: 'refactor.extract.function' } },
  ]);
  const input = { kind: 'refactor.extract.function' };
  assert.equal(
    guardReason({ toolName: 'code_action', input: { ...current.input, ...input } }),
    undefined,
  );
  assert.equal(JSON.parse(await current.invoke(input)).actions[0].available, true);
  assert.equal(
    JSON.parse(await current.invoke({ ...input, action: 'apply', title: 'Fix rate' })).completed,
    2,
  );
});

test('code action refuses unavailable, ambiguous, disabled, command-only and mismatched selections', async (context) => {
  const current = await setup(context);
  for (const result of [
    [],
    [current.action, current.action],
    [{ ...current.action, disabled: { reason: 'unsafe' } }],
    [{ ...current.action, edit: undefined, command: { command: 'arbitrary', title: 'bad' } }],
    [{ title: 'Fix rate', command: 'arbitrary' }],
    [{ ...current.action, kind: { value: 'source' } }],
    [{ ...current.action, edit: undefined }],
    Array(33).fill(current.action),
    {},
  ]) {
    fixture.commands.set('vscode.executeCodeActionProvider', () => result);
    await assert.rejects(current.invoke({ action: 'apply', title: 'Fix rate' }));
  }
  assert.equal(current.writes.length, 0);
  assert.ok(fixture.commandCalls.every((call) => call.id === 'vscode.executeCodeActionProvider'));
});

test('code action applies captured text while ignoring every attached command', async (context) => {
  const current = await setup(context);
  fixture.commands.set('vscode.executeCodeActionProvider', () => [
    {
      ...current.action,
      command: { command: 'arbitrary', title: 'Never execute', arguments: ['private'] },
    },
  ]);
  const listed = JSON.parse(await current.invoke());
  assert.equal(listed.actions[0].commandIgnored, true);
  assert.equal(listed.actions[0].available, true);
  assert.ok(!JSON.stringify(listed).includes('arbitrary'));
  await current.invoke({ action: 'apply', title: 'Fix rate' });
  assert.equal(current.writes.length, 2);
  assert.ok(fixture.commandCalls.every((call) => call.id === 'vscode.executeCodeActionProvider'));
});

test('code actions retain private/capture/range/freshness checks before writes', async (context) => {
  const current = await setup(context);
  for (const change of [
    { paths: ['private/secret.ts'] },
    { paths: ['other.ts'] },
    { endColumn: 999 },
    { line: 17, column: 1, endLine: 17, endColumn: 29 },
    { paths: ['/outside.ts'] },
  ])
    await assert.rejects(current.invoke(change));
  fixture.commands.set('vscode.executeCodeActionProvider', () => {
    current.documents[0]!.version++;
    return [current.action];
  });
  await assert.rejects(current.invoke({ action: 'apply', title: 'Fix rate' }), /stale/);
  assert.equal(current.writes.length, 0);
});

test('Stop releases code action discovery and late provider results cannot apply', async (context) => {
  const current = await setup(context);
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixture.commands.set('vscode.executeCodeActionProvider', () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = current.invoke();
  const rejected = assert.rejects(pending, /Stopped/);
  await started;
  current.abort.abort(new Error('Stopped'));
  await rejected;
  release([current.action]);
  await assert.rejects(current.invoke({ action: 'apply', title: 'Fix rate' }), /Stopped/);
  assert.equal(current.writes.length, 0);
});

test('registered code action traverses exact broker permission and durable review provenance', async (context) => {
  const current = await setup(context);
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  const handlers = new Map<string, (...args: any[]) => any>();
  installNativeCodeActions({
    registerTool: (value) => {
      tool = value;
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
  } as NativeEditApi);
  assert.equal(tool.approval, 'write');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const id = randomUUID();
  const input = codeActionRequest.parse({ ...current.input, action: 'apply', title: 'Fix rate' });
  const native = { cwd: current.cwd, sessionManager: { getSessionId: () => 'native' } };
  const execute = () => tool.execute(id, input, current.scope.signal, undefined, native);
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = current.scope.privateRoot;
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
  const tools = new HostTools(files, journal, path.join(current.scope.privateRoot, 'mutations'));
  await tools.run(
    { ...current.scope, sessionId: 'native', owner: 'local', turnId: 'turn' },
    async () => {
      await handlers.get('tool_call')!({ toolName: 'other' });
      await handlers.get('tool_result')!({ toolName: 'other' });
      await handlers.get('tool_call')!({ toolName: 'code_action', toolCallId: id, input });
      const permission = {
        sessionId: 'native',
        toolCall: { toolCallId: id, rawInput: input },
        options: [{ kind: 'allow_once', optionId: 'once', name: 'Allow Once' }],
      };
      assert.deepEqual(await tools.permission(permission as any), {
        outcome: { outcome: 'selected', optionId: 'once' },
      });
      const result = (await execute()) as { content: { text: string }[] };
      assert.equal(JSON.parse(result.content[0]!.text).completed, 2);
      await handlers.get('tool_result')!({ toolName: 'code_action', toolCallId: id });
    },
  );
  const reopened = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async () => {},
    JSON.parse(persisted),
  );
  assert.equal(reopened.list().length, 2);
  for (const change of reopened.list()) {
    assert.equal(change.operations![0]!.tool, 'code_action');
    assert.equal(change.operations![0]!.toolCallId, id);
    await reopened.discard(change.id);
    assert.equal(await files.read(change.path), 'const rate = 7;\n');
  }
  await assert.rejects(
    tool.execute(id, input, AbortSignal.abort(new Error('Stopped')), undefined, native),
    /Stopped/,
  );
});
