import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activate as activateHost, deactivate as deactivateHost } from '../extension.js';
import { fileSignal } from './production-terminal.integration.js';
import { StateStore } from '../state.js';
import { StorageMaintenance } from '../retention.js';

const directory = process.env.VS_OMP_TERMINAL_LIFECYCLE!;
const scenario = process.env.VS_OMP_TERMINAL_CASE ?? 'reload';

type Api = Awaited<ReturnType<typeof activateHost>>;

function host(context: vscode.ExtensionContext) {
  const storage = vscode.Uri.file(path.join(directory, 'storage'));
  return activateHost({
    subscriptions: context.subscriptions,
    extensionMode: vscode.ExtensionMode.Test,
    extensionUri: vscode.Uri.file(process.env.VS_OMP_NATIVE_EXTENSION_ROOT!),
    storageUri: storage,
    globalStorageUri: storage,
  } as vscode.ExtensionContext);
}

async function seedReview(api: Api) {
  const previous = process.env.VS_OMP_TEST_FIXTURE!;
  process.env.VS_OMP_TEST_FIXTURE = path.join(path.dirname(previous), 'history-fixture.mjs');
  const request = (message: object) => api.request!({ v: 1, ...message });
  try {
    await request({ type: 'new' });
    await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
    await request({ type: 'prompt', text: 'LIFECYCLE_REVIEW WRITE_FIXTURE' });
    assert.ok(api.storedState!().changes.length > 0);
    await request({ type: 'disconnect' });
  } finally {
    process.env.VS_OMP_TEST_FIXTURE = previous;
  }
}

async function dirtyEditor(root: vscode.Uri) {
  const target = vscode.Uri.joinPath(root, 'dirty.txt');
  await writeFile(target.fsPath, 'disk baseline\n');
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(target, document.positionAt(0), 'unsaved ');
  assert.ok(await vscode.workspace.applyEdit(edit));
  return { target, document };
}

function observeTerminal(context: vscode.ExtensionContext) {
  let owned: vscode.Terminal | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      if (!/^OMP [a-f0-9]{8}$/.test(terminal.name)) return;
      owned = terminal;
      const options = terminal.creationOptions;
      assert.ok('pty' in options && options.pty.onDidChangeName);
      context.subscriptions.push(
        options.pty.onDidChangeName((name) => {
          if (name.endsWith(': Waiting for User')) entered();
        }),
      );
    }),
  );
  return {
    waiting,
    name: () => {
      assert.ok(owned);
      return owned.name.split(':')[0];
    },
  };
}

async function checkpoint(api: Api, editor: Awaited<ReturnType<typeof dirtyEditor>>, name: string) {
  assert.ok(api.storedState!().changes.length > 0);
  await writeFile(
    path.join(directory, 'expected.json'),
    JSON.stringify({
      sessionId: api.status()!.sessionId,
      changes: api.storedState!().changes,
      dirtyUri: editor.target.toString(),
      dirtyText: editor.document.getText(),
      provider: await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, 'ready.json'),
    JSON.stringify({
      host: process.pid,
      omp: Number(await readFile(process.env.VS_OMP_FIXTURE_PID!, 'utf8')),
      worker: Number(await readFile(path.join(directory, 'worker.pid'), 'utf8')),
      terminal: name,
      trusted: vscode.workspace.isTrusted,
    }),
    { mode: 0o600 },
  );
}

async function prepare(context: vscode.ExtensionContext) {
  assert.equal(vscode.workspace.isTrusted, true);
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const api = await host(context);
  await vscode.commands.executeCommand('omp.open');
  await seedReview(api);
  const editor = await dirtyEditor(root);
  const request = (message: object) => api.request!({ v: 1, ...message });
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  const observed = observeTerminal(context);
  const running = request({ type: 'prompt', text: 'NATIVE_TERMINAL_LIFECYCLE' });
  void running.catch(() => {});
  await Promise.race([
    observed.waiting,
    running.then(() => {
      throw new Error('No takeover hold.');
    }),
  ]);
  await fileSignal(path.join(directory, 'worker.pid'));
  if (!scenario.startsWith('privacy-'))
    await request({ type: 'queuePrompt', text: 'MUST_NOT_RUN_AFTER_LIFECYCLE' });
  await checkpoint(api, editor, observed.name()!);
  if (scenario === 'mixed-attention') {
    await vscode.commands.executeCommand('notifications.showList');
    await finishMixed(api, editor, running);
  } else if (scenario.startsWith('privacy-')) {
    await running;
    await finishPrivacy(api);
  } else await running.catch(() => {});
}

async function finishMixed(
  api: Api,
  editor: Awaited<ReturnType<typeof dirtyEditor>>,
  running: Promise<unknown>,
) {
  const before = api.status()!;
  const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
  await fileSignal(path.join(directory, 'mixed-clicked'));
  assert.equal(api.status()!.sessionId, before.sessionId);
  assert.equal(api.status()!.busy, true);
  assert.ok((await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')) === expected.provider);
  assert.deepEqual(api.storedState!().changes, expected.changes);
  assert.equal(editor.document.getText(), expected.dirtyText);
  assert.equal(editor.document.isDirty, true);
  await writeFile(path.join(directory, 'mixed-checked'), 'checked', { mode: 0o600 });
  await running.catch(() => {});
  const after = api.status()!;
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.busy, false);
  assert.equal(after.queued.length, 0);
  assert.equal(after.turns.at(-1)!.status, 'cancelled');
  assert.ok((await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')) === expected.provider);
  assert.deepEqual(api.storedState!().changes, expected.changes);
  assert.equal(editor.document.getText(), expected.dirtyText);
  assert.equal(editor.document.isDirty, true);
  assert.equal(await readFile(editor.target.fsPath, 'utf8'), 'disk baseline\n');
  await api.request!({ v: 1, type: 'disconnect' });
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({
      ok: true,
      cancelled: true,
      queueEmpty: true,
      staleActionIgnored: true,
      providerUnchanged: true,
      dirtyPreserved: true,
      reviewPreserved: true,
    }),
    { mode: 0o600 },
  );
}

async function finishPrivacy(api: Api) {
  assert.equal(api.status()!.busy, false);
  assert.equal(api.status()!.queued.length, 0);
  const provider = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
  const user = provider.messages.findLastIndex(
    (message: { role: string }) => message.role === 'user',
  );
  const results = provider.messages
    .slice(user + 1)
    .filter((message: { role: string }) => message.role === 'toolResult');
  assert.equal(results.length, 5);
  const cancelled = scenario === 'privacy-cancel';
  for (const index of [2, 3]) {
    assert.equal(results[index].isError ?? false, scenario !== 'privacy-success');
    if (cancelled) assert.match(JSON.stringify(results[index].content), /cancelled/);
    else {
      const result = JSON.parse(
        results[index].content.find((block: { type: string }) => block.type === 'text').text,
      );
      assert.equal(result.output, '');
      assert.equal(result._meta['vs-omp/capture'], 'withheld-after-takeover');
      assert.equal(result.exitStatus.exitCode, scenario === 'privacy-success' ? 0 : 1);
    }
  }
  const status = api.status()!;
  await writeFile(
    path.join(directory, 'chat-state.json'),
    JSON.stringify({ status, stored: api.storedState!() }),
    { mode: 0o600 },
  );
  await api.request!({ v: 1, type: 'disconnect' });
  const store = new StateStore(path.join(directory, 'storage'));
  await store.load();
  await new StorageMaintenance(store).exportSession(
    status.sessionId!,
    path.join(directory, 'export.json'),
  );
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({
      ok: true,
      privacy: true,
      commandCancelled: cancelled,
      toolResults: results.length,
      theme: vscode.window.activeColorTheme.kind,
      zoom: vscode.workspace.getConfiguration('window').get('zoomLevel'),
      queueEmpty: true,
    }),
    { mode: 0o600 },
  );
}

async function recover(context: vscode.ExtensionContext) {
  assert.equal(vscode.workspace.isTrusted, true);
  const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
  const api = await host(context);
  const state = api.storedState!();
  const session = state.sessions.find((candidate) => candidate.id === expected.sessionId);
  assert.ok(session);
  assert.ok(session.turns.every((turn) => turn.status !== 'running'));
  assert.equal(session.turns.at(-1)!.status, 'cancelled');
  assert.equal(api.status()!.queued.length, 0);
  assert.equal(api.status()!.busy, false);
  assert.deepEqual(state.changes, expected.changes);
  assert.equal(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'), expected.provider);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(expected.dirtyUri));
  assert.equal(document.getText(), expected.dirtyText);
  assert.equal(document.isDirty, true);
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  assert.equal(
    await readFile(vscode.Uri.joinPath(root, 'dirty.txt').fsPath, 'utf8'),
    'disk baseline\n',
  );
  assert.equal(
    await readFile(vscode.Uri.joinPath(root, 'history.txt').fsPath, 'utf8'),
    'agent version\n',
  );
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({
      ok: true,
      trusted: true,
      cancelled: true,
      queueEmpty: true,
      providerUnchanged: true,
      dirtyPreserved: true,
      reviewPreserved: true,
    }),
    { mode: 0o600 },
  );
}

export function activate(context: vscode.ExtensionContext) {
  void readFile(path.join(directory, 'phase'), 'utf8')
    .then(async (phase) => {
      if (phase === 'prepare') {
        await fileSignal(path.join(directory, 'start'));
        await prepare(context);
      } else {
        await fileSignal(path.join(directory, 'recover'));
        await recover(context);
      }
    })
    .catch((error: unknown) =>
      writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.stack : String(error),
        }),
        { mode: 0o600 },
      ),
    );
}

export async function deactivate() {
  await deactivateHost();
}
