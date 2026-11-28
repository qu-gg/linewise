import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, seedFile } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { view } from './vscode-fixture.js';
import type {
  CustomReadonlyEditorProvider,
  WebviewPanel,
  WebviewPanelOnDidChangeViewStateEvent,
  Uri,
} from 'vscode';

const vscode = await import('vscode');

function reviewPanel() {
  const messages: Record<string, unknown>[] = [];
  let receive: (message: unknown) => unknown;
  const disposed = new vscode.EventEmitter<void>();
  const changed = new vscode.EventEmitter<WebviewPanelOnDidChangeViewStateEvent>();
  const panel = {
    active: true,
    title: '',
    webview: {
      ...view.webview,
      postMessage: async (message: Record<string, unknown>) => {
        messages.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: typeof receive) => {
        receive = listener;
        return { dispose() {} };
      },
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: changed.event,
    dispose: () => disposed.fire(),
  } as unknown as WebviewPanel;
  return {
    panel,
    messages,
    send: async (message: unknown) => {
      await receive(message);
    },
    disposed,
    changed,
  };
}

async function headerFooterHost(context: import('node:test').TestContext) {
  let provider: CustomReadonlyEditorProvider;
  context.mock.method(
    vscode.window,
    'registerCustomEditorProvider',
    (_id: string, value: typeof provider) => {
      provider = value;
      return { dispose() {} };
    },
  );
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const target = path.join(host.root, 'HeaderFooter.txt');
  const before = `Header:\r\n${'context\r\n'.repeat(12)}Footer:\r\n`;
  seedFile(target, before);
  transport.onPrompt = async () => {
    await transport.client!.handlers.write({
      sessionId: transport.client!.sessionId,
      path: target,
      content: before.replace('Header:', 'HEADER:').replace('Footer:', 'FOOTER:'),
    });
  };
  await host.request({ type: 'prompt', text: 'Change Header/Footer' });
  const change = host.status()!.changes[0]!;
  await host.request({ type: 'review', id: change.id });
  const uri = fixture.commandCalls.filter((call) => call.id === 'vscode.openWith').at(-1)!
    .args[0] as Uri;
  await assert.rejects(
    async () => provider!.openCustomDocument(vscode.Uri.file(target), {} as never, {} as never),
    /owned/,
  );
  const document = await provider!.openCustomDocument(uri, {} as never, {} as never);
  const surface = reviewPanel();
  context.after(() => {
    surface.panel.dispose();
    surface.disposed.dispose();
    surface.changed.dispose();
  });
  await provider!.resolveCustomEditor(document, surface.panel, {} as never);
  const state = () => surface.messages.at(-1)!;
  const action = (hunkId: string, operation: string) => ({
    type: 'reviewAction',
    changeId: change.id,
    revision: state().revision,
    hunkId,
    operation,
  });
  return { host, target, before, change, surface, state, action };
}

test('floating review dispatch rejects late controls and resolves only owned Header/Footer hunks', async (context) => {
  const { host, target, before, change, surface, state, action } = await headerFooterHost(context);
  const [first, second] = change.hunks;
  assert.ok(first && second);
  assert.equal(state().text, before.replace('Header:', 'HEADER:').replace('Footer:', 'FOOTER:'));
  assert.deepEqual(
    (state().hunks as { id: string }[]).map((hunk) => hunk.id),
    [first.id, second.id],
  );
  const late = action(first.id, 'discard');
  await surface.send({ type: 'ready' });
  await surface.send(late);
  assert.equal(host.status()!.changes[0]!.hunks.length, 2);
  await surface.send({ ...action(first.id, 'keep'), changeId: 'foreign' });
  assert.equal(host.status()!.changes[0]!.hunks.length, 2);
  await surface.send(action(first.id, 'keep'));
  assert.deepEqual(
    (state().hunks as { id: string }[]).map((hunk) => hunk.id),
    [second.id],
  );
  assert.equal(host.storedState!().changes[0]!.before, before.replace('Header:', 'HEADER:'));
  await surface.send(action(first.id, 'discard'));
  assert.equal(host.status()!.changes[0]!.hunks.length, 1);
  await surface.send(action(second.id, 'discard'));
  assert.deepEqual(host.status()!.changes, []);
  assert.equal(
    Buffer.from(fixture.disk.get(target)!.bytes).toString(),
    before.replace('Header:', 'HEADER:'),
  );
  assert.ok(
    fixture.commandCalls.some(
      (call) => call.id === 'vscode.openWith' && call.args[1] === 'default',
    ),
  );
  await surface.send(action(first.id, 'discard'));
  assert.equal(
    Buffer.from(fixture.disk.get(target)!.bytes).toString(),
    before.replace('Header:', 'HEADER:'),
  );
});

test('editable proposals persist off disk and whole-file Keep writes the exact edited text', async (context) => {
  const { host, target, before, change, surface, state, action } = await headerFooterHost(context);
  const edited = `${before.replace('Header:', 'HEADER:').replace('Footer:', 'FOOTER:')}// reviewed\n`;
  await surface.send({
    type: 'proposal',
    changeId: change.id,
    revision: state().revision,
    text: edited,
  });
  assert.equal(host.storedState!().changes[0]!.after, edited);
  assert.equal(
    Buffer.from(fixture.disk.get(target)!.bytes).toString(),
    before.replace('Header:', 'HEADER:').replace('Footer:', 'FOOTER:'),
  );
  assert.equal(state().edited, true);
  await surface.send({
    ...action(undefined as unknown as string, 'keep'),
    hunkId: undefined,
    text: edited,
  });
  assert.equal(Buffer.from(fixture.disk.get(target)!.bytes).toString(), edited);
  assert.deepEqual(host.status()!.changes, []);
});

test('a stale historical edit retains session state and returns a failed editing acknowledgement', async (context) => {
  const host = await setup(context);
  await assert.rejects(host.request({ type: 'editPrompt', id: 'missing', text: 'Replacement' }));
  assert.equal(host.status()!.busy, false);
  assert.deepEqual(host.status()!.turns, []);
});

async function inlineLifecycle(context: import('node:test').TestContext) {
  const { InlineReviewView } = await import('../inline-review-view.js');
  const { WorkspaceFiles } = await import('../workspace.js');
  const files = new WorkspaceFiles(vscode.Uri.file('/workspace'));
  const before = `first\n${'context\n'.repeat(12)}last\n`;
  const change = {
    id: 'inline-owner',
    sessionId: 'owner',
    path: '/workspace/code.ts',
    before,
    after: before.replace('first', 'FIRST').replace('last', 'LAST'),
    state: 'pending' as 'pending' | 'conflict',
    updatedAt: 1,
  };
  const control = { changes: [change], available: true, failure: false };
  const requests: unknown[] = [];
  const editor = new InlineReviewView(
    vscode.Uri.file('/extension'),
    files,
    {
      changes: () => control.changes,
      available: () => control.available,
      dispatch: async (request) => {
        if (control.failure) throw new Error('Dirty buffer refused.');
        requests.push(request);
      },
      edit: async (id, text) => {
        if (control.failure) throw new Error('Dirty buffer refused.');
        requests.push({ type: 'proposal', id, text });
      },
      reset: async (id) => {
        if (control.failure) throw new Error('Dirty buffer refused.');
        requests.push({ type: 'reset', id });
      },
    },
    () => {},
  );
  const registrations = editor.register();
  const surface = reviewPanel();
  context.after(() => {
    editor.dispose();
    for (const item of registrations) item.dispose();
    surface.disposed.dispose();
    surface.changed.dispose();
    files.reviewRequested.dispose();
    files.reviewChanges.dispose();
  });
  assert.equal(await editor.atCursor('Next'), false);
  const uri = files.updateReview(change)[1]!;
  const document = editor.openCustomDocument(uri);
  editor.resolveCustomEditor(document, surface.panel);
  const state = () => surface.messages.at(-1)!;
  const action = () => ({
    type: 'reviewAction',
    changeId: change.id,
    revision: state().revision,
    operation: 'keep',
    hunkId: (state().hunks as { id: string }[])[0]?.id,
  });
  return { editor, surface, change, control, requests, state, action };
}

test('blocked and conflicting custom inline owners cannot mutate', async (context) => {
  const { editor, surface, change, control, requests, state, action } =
    await inlineLifecycle(context);
  await surface.send(undefined);
  await surface.send({ ...action(), type: 'other' });
  await surface.send({ ...action(), operation: 'invalid' });
  control.available = false;
  editor.refresh();
  assert.equal(state().available, false);
  await surface.send(action());
  await assert.rejects(editor.atCursor('Keep'), /current OMP/);
  assert.equal(requests.length, 0);
  control.available = true;
  change.state = 'conflict';
  editor.refresh();
  assert.deepEqual(state().parts, []);
  assert.equal(state().problem, 'File changed outside OMP.');
  await surface.send(action());
  assert.equal(requests.length, 0);
});

test('custom inline navigation, dirty refusal and retired owners preserve control identity', async (context) => {
  const { editor, surface, control, requests, state, action } = await inlineLifecycle(context);
  editor.refresh();
  await surface.send({ ...action(), type: 'cursor', line: 14 });
  await editor.atCursor('Keep');
  await editor.atCursor('Discard');
  assert.deepEqual(
    requests.map((request) => (request as { type: string }).type),
    ['hunkKeep', 'hunkDiscard'],
  );
  await editor.atCursor('Next');
  await editor.atCursor('Previous');
  await surface.send({ ...action(), type: 'cursor', line: -1 });
  control.failure = true;
  await surface.send(action());
  assert.equal(state().problem, 'Dirty buffer refused.');
  control.changes = [];
  editor.refresh();
  assert.deepEqual(state().hunks, []);
  await surface.send(action());
  assert.equal(requests.length, 2);
  await assert.rejects(
    async () =>
      editor.resolveCustomEditor(
        {
          uri: vscode.Uri.from({ scheme: 'omp-review', path: '/inline-owner/after/code.ts' }),
          dispose() {},
        },
        surface.panel,
      ),
    /no longer/,
  );
  surface.changed.fire({ webviewPanel: surface.panel });
  surface.panel.dispose();
  await surface.send(action());
  assert.equal(editor.available, false);
});

test('host hunk actions open inline review and preserve accepted text across later writes', async (context) => {
  let editor: import('vscode').CodeLensProvider;
  context.mock.method(
    vscode.languages,
    'registerCodeLensProvider',
    (_selector: unknown, provider: typeof editor) => {
      editor = provider;
      return { dispose() {} };
    },
  );
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const target = path.join(host.root, 'hunks.txt');
  const before = Array.from({ length: 16 }, (_, index) => `line ${index}\n`).join('');
  seedFile(target, before);
  transport.onPrompt = async () => {
    await transport.client!.handlers.write({
      sessionId: transport.client!.sessionId,
      path: target,
      content: before.replace('line 0', 'kept').replace('line 15', 'discarded'),
    });
  };
  await host.request({ type: 'prompt', text: 'Change two areas' });
  const change = host.status()!.changes[0]!;
  assert.equal(change.operations[0]!.kind, 'edit');
  assert.equal(change.operations[0]!.turnId, host.status()!.turns[0]!.id);
  assert.equal(change.operations[0]!.tool, 'write');
  assert.equal(change.operations[0]!.added, 2);
  assert.equal(change.operations[0]!.removed, 2);
  const [first, second] = change.hunks;
  assert.ok(first && second);
  await host.request({ type: 'hunkReview', id: change.id, hunkId: second.id });
  assert.ok(
    fixture.commandCalls.some(
      (call) => call.id === 'vscode.openWith' && call.args[1] === 'omp.inlineReview',
    ),
  );
  assert.ok(!fixture.commandCalls.some((call) => call.id === 'vscode.diff'));
  const uri = vscode.Uri.from({ scheme: 'omp-review', path: `/${change.id}/after/hunks.txt` });
  const document = { uri, lineCount: 16 } as import('vscode').TextDocument;
  const lenses = (await editor!.provideCodeLenses(document, {} as never))!;
  assert.equal(lenses.length, 4);
  assert.equal(lenses[0]!.command!.title, 'Keep Change');
  assert.equal(lenses[1]!.command!.title, 'Discard Change');
  await vscode.commands.executeCommand('omp.reviewHunk', ...lenses[0]!.command!.arguments!);
  assert.equal((await editor!.provideCodeLenses(document, {} as never))!.length, 2);
  await assert.rejects(
    host.request({ type: 'hunkDiscard', id: change.id, hunkId: first.id }),
    /stale/,
  );
  const remaining = (await editor!.provideCodeLenses(document, {} as never))!;
  await vscode.commands.executeCommand('omp.reviewHunk', ...remaining[1]!.command!.arguments!);
  assert.deepEqual(host.status()!.changes, []);
  assert.deepEqual(await editor!.provideCodeLenses(document, {} as never), []);
  await assert.rejects(
    host.request({ type: 'hunkKeep', id: change.id, hunkId: second.id }),
    /active session/,
  );
  await host.request({ type: 'prompt', text: 'Edit again' });
  assert.equal(host.storedState!().changes[0]!.before, before.replace('line 0', 'kept'));
});

test('editor review controls require an owned modified snapshot and an idle current pending change', async (context) => {
  const { WorkspaceFiles, ReviewEditor } = await import('../workspace.js');
  const files = new WorkspaceFiles(vscode.Uri.file('/workspace'));
  const change = {
    id: 'editor-owner',
    sessionId: 'owner',
    path: '/workspace/owned.ts',
    before: 'old\n',
    after: 'new\n',
    state: 'pending' as 'pending' | 'conflict',
    updatedAt: 1,
  };
  let available = true;
  let changes = [change];
  const editor = new ReviewEditor(files, {
    changes: () => changes,
    available: () => available,
    dispatch: async () => {},
    edit: async () => {},
    reset: async () => {},
  });
  context.after(() => {
    editor.dispose();
    files.reviewChanges.dispose();
  });
  const document = (scheme: string, side = 'after') =>
    ({
      uri: vscode.Uri.from({ scheme, path: `/editor-owner/${side}/owned.ts` }),
      lineCount: 0,
    }) as import('vscode').TextDocument;
  assert.deepEqual(editor.provideCodeLenses(document('file')), []);
  assert.deepEqual(editor.provideCodeLenses(document('omp-review')), []);
  files.updateReview(change);
  assert.deepEqual(editor.provideCodeLenses(document('omp-review', 'before')), []);
  assert.equal(editor.provideCodeLenses(document('omp-review')).length, 2);
  available = false;
  assert.deepEqual(editor.provideCodeLenses(document('omp-review')), []);
  available = true;
  change.state = 'conflict';
  assert.deepEqual(editor.provideCodeLenses(document('omp-review')), []);
  change.state = 'pending';
  let refreshed = 0;
  editor.onDidChangeCodeLenses(() => refreshed++);
  editor.refresh();
  changes = [{ ...change, id: 'unopened' }];
  editor.refresh();
  assert.equal(refreshed, 2);
  assert.deepEqual(editor.provideCodeLenses(document('omp-review')), []);
  assert.equal(files.reviewSnapshots.size, 2);
});

test('editor title actions navigate and resolve only the current hunk without requiring diff CodeLens settings', async (context) => {
  const { WorkspaceFiles, ReviewEditor } = await import('../workspace.js');
  const files = new WorkspaceFiles(vscode.Uri.file('/workspace'));
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
  const change = {
    id: 'cursor',
    sessionId: 'owner',
    path: '/workspace/cursor.ts',
    before,
    after: before.replace('line 0', 'kept').replace('line 19', 'discarded'),
    state: 'pending' as const,
    updatedAt: 1,
  };
  const requests: unknown[] = [];
  let available = true;
  const editor = new ReviewEditor(files, {
    changes: () => [change],
    available: () => available,
    dispatch: async (request) => {
      requests.push(request);
    },
    edit: async () => {},
    reset: async () => {},
  });
  context.after(() => {
    editor.dispose();
    files.reviewChanges.dispose();
  });
  await assert.rejects(editor.atCursor('Keep'), /current OMP change/);
  const uris = files.updateReview(change);
  const updates = context.mock.method(files, 'updateReview');
  editor.refresh();
  assert.equal(updates.mock.calls.length, 1);
  const document = { uri: uris[1]!, lineCount: 20 } as import('vscode').TextDocument;
  fixture.editor = { document, selection: { active: { line: 0 } } } as never;
  const lenses = editor.provideCodeLenses(document);
  await editor.atCursor('Keep');
  await editor.atCursor('Discard');
  assert.deepEqual(requests, [
    lenses[0]!.command!.arguments![0],
    lenses[1]!.command!.arguments![0],
  ]);
  await editor.atCursor('Next');
  assert.equal(
    files.reviewSelections.get(uris[1]!.toString()),
    (lenses[2]!.command!.arguments![0] as { hunkId: string }).hunkId,
  );
  await editor.atCursor('Previous');
  editor.refresh();
  assert.deepEqual(fixture.commandCalls.at(-1)!.args, ['omp.reviewAvailable', true]);
  available = false;
  editor.refresh();
  assert.deepEqual(fixture.commandCalls.at(-1)!.args, ['omp.reviewAvailable', false]);
  await assert.rejects(editor.atCursor('Discard'), /current OMP change/);
  fixture.editor = undefined;
});

test('custom inline proposals and reset are revision-bound and never mutate stale owners', async (context) => {
  const { surface, state, requests, change } = await inlineLifecycle(context);
  await surface.send({
    type: 'proposal',
    changeId: change.id,
    revision: state().revision,
    text: 'edited proposal',
  });
  assert.deepEqual(requests.at(-1), {
    type: 'proposal',
    id: change.id,
    text: 'edited proposal',
  });
  const length = requests.length;
  await surface.send({
    type: 'proposal',
    changeId: change.id,
    revision: 'stale',
    text: 'stale proposal',
  });
  assert.equal(requests.length, length);
  await surface.send({
    type: 'reset',
    changeId: change.id,
    revision: state().revision,
  });
  assert.deepEqual(requests.at(-1), { type: 'reset', id: change.id });
});
