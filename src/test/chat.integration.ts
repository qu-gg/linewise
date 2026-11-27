import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { nativeCompaction } from './compaction.integration.js';
import { fileSignal } from './production-terminal.integration.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Request = (message: object) => Promise<void>;

async function providerContext() {
  assert.ok(process.env.VS_OMP_FIXTURE_CONTEXT);
  return JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT, 'utf8'));
}

async function repositoryReadout(api: Api, request: Request, root: vscode.Uri) {
  const uri = vscode.Uri.joinPath(root, 'repository-readout.md');
  const diskText = 'ON_DISK_REPOSITORY_READOUT\n';
  const bufferText = 'UNSAVED_REPOSITORY_READOUT\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(diskText));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'readout/nested'));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(root, 'readout/nested/arbitrary.policy'),
    Buffer.from('NESTED_READ_SENTINEL\n'),
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(root, 'readout/nested/large.txt'),
    Buffer.from('line\n'.repeat(220000) + 'LARGE_READ_SENTINEL\n'),
  );
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    bufferText,
  );
  assert.ok(await vscode.workspace.applyEdit(edit));
  const configuration = vscode.workspace.getConfiguration('omp');
  const previous = configuration.inspect('permissions.commandRules')?.globalValue;
  const changes = structuredClone(api.status()!.changes);
  await configuration.update(
    'permissions.commandRules',
    [
      { command: ['ls', '-la'], action: 'allow', match: 'exact' },
      { command: ['ls'], action: 'allow', match: 'exact' },
    ],
    vscode.ConfigurationTarget.Global,
  );
  try {
    for (const variant of [
      'root',
      'absolute',
      'slash',
      'text',
      'range',
      'nested',
      'large',
      'shell',
      'nullable',
      'cwd',
      'zero',
    ]) {
      await request({ type: 'prompt', text: `REPOSITORY_READOUT_FIXTURE ${variant}` });
      const context = await providerContext();
      const reply = context.messages.findLast(
        (message: { role: string }) => message.role === 'toolResult',
      );
      assert.ok(reply, `The ${variant} probe must reach the actual tool.`);
      assert.notEqual(reply.isError, true, `${variant}: ${JSON.stringify(reply.content)}`);
      const text = JSON.stringify(reply.content);
      if (variant === 'text' || variant === 'range') {
        assert.match(text, /UNSAVED_REPOSITORY_READOUT/);
        assert.doesNotMatch(text, /ON_DISK_REPOSITORY_READOUT/);
      } else if (variant === 'nested') assert.match(text, /NESTED_READ_SENTINEL/);
      else if (variant === 'large') assert.match(text, /LARGE_READ_SENTINEL/);
      else assert.match(text, /repository-readout\.md/);
    }
    assert.equal(document.getText(), bufferText);
    assert.equal(document.isDirty, true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), diskText);
    assert.deepEqual(api.status()!.changes, changes);
    console.log(
      'PASS: native repository inspection lists relative/absolute roots, reads unsaved text and runs nullable/default bash arguments without changing files or review ownership.',
    );
  } finally {
    await configuration.update(
      'permissions.commandRules',
      previous,
      vscode.ConfigurationTarget.Global,
    );
  }
}

async function hunkReview(api: Api, request: Request, root: vscode.Uri) {
  const uri = vscode.Uri.joinPath(root, 'chat-hunks.txt');
  const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(before));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  await request({ type: 'prompt', text: 'HUNK_REVIEW_FIXTURE' });
  const change = api.status()!.changes.find((candidate) => candidate.name === 'chat-hunks.txt')!;
  assert.equal(change.hunks.length, 2);
  assert.equal(change.kind, 'edit');
  assert.equal(change.operations[0]!.turnId, api.status()!.turns.at(-1)!.id);
  await request({ type: 'hunkReview', id: change.id, hunkId: change.hunks[1]!.id });
  await request({ type: 'hunkKeep', id: change.id, hunkId: change.hunks[0]!.id });
  const remaining = api.status()!.changes.find((candidate) => candidate.id === change.id)!;
  assert.equal(remaining.hunks.length, 1);
  await request({ type: 'hunkDiscard', id: change.id, hunkId: remaining.hunks[0]!.id });
  assert.equal(document.getText(), before.replace('line 2\r\n', 'agent 2\r\n'));
  assert.equal(await readFile(uri.fsPath, 'utf8'), document.getText());
  await assert.rejects(
    request({ type: 'hunkKeep', id: change.id, hunkId: change.hunks[0]!.id }),
    /active session/,
  );
  console.log(
    'PASS: native hunk navigation/Keep/Discard preserve CRLF, accepted text and operation ownership.',
  );
}

async function multipleContext(api: Api, request: Request) {
  const selected = await vscode.workspace.openTextDocument({
    content: 'UNSELECTED_PREFIX\nNATIVE_SELECTED_SNAPSHOT\nUNSELECTED_SUFFIX',
  });
  const editor = await vscode.window.showTextDocument(selected);
  editor.selection = new vscode.Selection(
    new vscode.Position(1, 0),
    new vscode.Position(1, 'NATIVE_SELECTED_SNAPSHOT'.length),
  );
  await request({ type: 'attach' });
  const resource = await vscode.workspace.openTextDocument({ content: 'NATIVE_SECOND_SNAPSHOT' });
  await vscode.window.showTextDocument(resource);
  await request({ type: 'attach' });
  assert.equal(api.status()!.attachments.length, 2);
  const first = api.status()!.attachments[0]!;
  await request({ type: 'inspectAttachment', id: first.id });
  await request({ type: 'prompt', text: 'NATIVE_MULTI_CONTEXT' });
  const turn = api.status()!.turns.at(-1)!;
  assert.equal(turn.attachments!.length, 2);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    resource.uri,
    new vscode.Range(resource.positionAt(0), resource.positionAt(resource.getText().length)),
    'NATIVE_LATER_EDITOR_TEXT',
  );
  assert.ok(await vscode.workspace.applyEdit(edit));
  await request({ type: 'editPrompt', id: turn.id, text: 'NATIVE_REPLAY_CONTEXT' });
  const messages = JSON.stringify((await providerContext()).messages);
  assert.match(messages, /NATIVE_SELECTED_SNAPSHOT/);
  assert.match(messages, /NATIVE_SECOND_SNAPSHOT/);
  assert.doesNotMatch(messages, /UNSELECTED_PREFIX|UNSELECTED_SUFFIX|NATIVE_LATER_EDITOR_TEXT/);
  assert.equal(resource.isDirty, true);
  console.log(
    'PASS: native multiple/selection context and historical replay use immutable snapshots, not unrelated or later dirty editor text.',
  );
}

async function queuedPrompts(api: Api, request: Request) {
  const running = request({ type: 'prompt', text: 'NATIVE_QUEUE_HEAD' });
  assert.equal(api.status()!.cancellable, true);
  await request({ type: 'queuePrompt', text: 'NATIVE_QUEUE_SECOND' });
  await request({ type: 'queuePrompt', text: 'NATIVE_QUEUE_REMOVE' });
  await request({ type: 'removeQueued', id: api.status()!.queued[1]!.id });
  await running;
  assert.equal(api.status()!.turns.at(-1)!.prompt, 'NATIVE_QUEUE_SECOND');
  assert.equal(api.status()!.queued.length, 0);
  const messages = JSON.stringify((await providerContext()).messages);
  assert.match(messages, /NATIVE_QUEUE_HEAD/);
  assert.match(messages, /NATIVE_QUEUE_SECOND/);
  assert.doesNotMatch(messages, /NATIVE_QUEUE_REMOVE/);
  const cancelled = request({ type: 'prompt', text: 'NATIVE_QUEUE_CANCEL_HEAD' });
  await request({ type: 'queuePrompt', text: 'NATIVE_QUEUE_CANCEL_PENDING' });
  await request({ type: 'cancel' });
  await cancelled;
  assert.equal(api.status()!.queued.length, 0);
  assert.doesNotMatch(
    JSON.stringify((await providerContext()).messages),
    /NATIVE_QUEUE_CANCEL_PENDING/,
  );
  console.log(
    'PASS: native follow-ups serialize after full cleanup, removed items never send and Stop clears pending prompts.',
  );
}

async function rootDeadline<Value>(pending: Promise<Value>): Promise<Value> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native root transition deadline.')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function observeRootTerminal() {
  let owned: vscode.Terminal | undefined;
  let opened = 0;
  let ready!: (terminal: vscode.Terminal) => void;
  let closed!: () => void;
  const waiting = new Promise<vscode.Terminal>((resolve) => {
    ready = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const subscriptions = [
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === owned) closed();
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      if (!/^OMP [a-f0-9]{8}$/.test(terminal.name)) return;
      owned = terminal;
      opened++;
      const options = terminal.creationOptions;
      assert.ok('pty' in options && options.pty.onDidChangeName);
      subscriptions.push(
        options.pty.onDidChangeName((name) => {
          if (name.endsWith(': Waiting for User')) ready(terminal);
        }),
      );
    }),
  ];
  return {
    waiting,
    ended,
    count: () => opened,
    dispose: () => subscriptions.forEach((item) => item.dispose()),
  };
}

async function changeAdditionalRoot(uri?: vscode.Uri): Promise<void> {
  let changed!: () => void;
  const event = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const subscription = vscode.workspace.onDidChangeWorkspaceFolders(changed);
  try {
    assert.ok(
      uri
        ? vscode.workspace.updateWorkspaceFolders(1, 0, { uri })
        : vscode.workspace.updateWorkspaceFolders(1, 1),
    );
    await rootDeadline(event);
  } finally {
    subscription.dispose();
  }
}

async function rootTransitionEnvironment(root: vscode.Uri) {
  const command = 'printf READY; read -r value';
  const extra = vscode.Uri.file(path.join(path.dirname(root.fsPath), 'root-transition-extra'));
  await vscode.workspace.fs.createDirectory(extra);
  const configuration = vscode.workspace.getConfiguration('omp');
  const previousRules = configuration.inspect('permissions.commandRules')?.globalValue;
  const environment = {
    VS_OMP_TEST_FIXTURE: path.join(
      path.dirname(process.env.VS_OMP_TEST_FIXTURE!),
      'terminal-handoff-fixture.mjs',
    ),
    VS_OMP_FIXTURE_PID: vscode.Uri.joinPath(root, 'root-transition-omp.pid').fsPath,
    VS_OMP_FIXTURE_HANDOFF: JSON.stringify({ command }),
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  await configuration.update(
    'permissions.commandRules',
    [
      { command: ['printf', 'READY'], match: 'exact', action: 'allow' },
      { command: ['read', '-r', 'value'], match: 'exact', action: 'allow' },
      { command: ['printf', 'OTHER_SAFE_WORK'], match: 'exact', action: 'allow' },
    ],
    vscode.ConfigurationTarget.Global,
  );
  return {
    extra,
    restore: async () => {
      await configuration.update(
        'permissions.commandRules',
        previousRules,
        vscode.ConfigurationTarget.Global,
      );
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function terminalControlsHandshake(root: vscode.Uri, owned: vscode.Terminal, action: string) {
  if (action !== 'roots') return;
  await writeFile(
    vscode.Uri.joinPath(root, 'native-terminal-controls-ready.json').fsPath,
    JSON.stringify({ terminal: owned.name.split(':')[0] }),
    { mode: 0o600 },
  );
  await fileSignal(vscode.Uri.joinPath(root, 'native-terminal-controls-done').fsPath);
}

async function heldSessionControls(api: Api) {
  const request = (message: object) => api.request!({ v: 1, ...message });
  const id = api.status()!.sessionId!;
  const before = api.storedState!();
  await request({ type: 'sessions' });
  await request({ type: 'refreshSessions' });
  assert.equal(api.status()!.sessionId, id);
  assert.equal(api.status()!.busy, true);
  for (const type of ['openSession', 'resumeSession', 'archiveSession', 'restoreSession'])
    await assert.rejects(request({ type, id }), /current operation/);
  await assert.rejects(
    request({ type: 'renameSession', id, title: 'MUST_NOT_RENAME_HELD_OWNER' }),
    /current operation/,
  );
  assert.deepEqual(api.storedState!(), before);
}

async function nativeHandoffTransition(
  api: Api,
  root: vscode.Uri,
  action: 'roots' | 'stop' | 'disconnect',
) {
  const request = (message: object) => api.request!({ v: 1, ...message });
  const fixture = await rootTransitionEnvironment(root);
  const observer = observeRootTerminal();
  const controlWrites = new vscode.EventEmitter<string>();
  let controlClosed = false;
  const control = vscode.window.createTerminal({
    name: 'Root transition unrelated fixture control',
    isTransient: true,
    pty: {
      onDidWrite: controlWrites.event,
      open() {},
      close() {
        controlClosed = true;
      },
    },
  });
  const dirty = vscode.workspace.textDocuments
    .filter((document) => document.isDirty)
    .map((document) => ({ document, text: document.getText() }));
  let running: Promise<void> | undefined;
  try {
    await request({ type: 'new' });
    await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
    const changes = structuredClone(api.status()!.changes);
    running = request({ type: 'prompt', text: 'NATIVE_ROOT_HANDOFF' });
    void running.catch(() => {});
    const owned = await rootDeadline(
      Promise.race([
        observer.waiting,
        running.then(() => {
          throw new Error('Prompt ended before native takeover.');
        }),
      ]),
    );
    const before = await providerContext();
    assert.equal(before.fixtureReply[0].arguments.action, 'takeover');
    await terminalControlsHandshake(root, owned, action);
    for (const message of [{ type: 'new' }, { type: 'permissions', mode: 'rules' }])
      await assert.rejects(request(message), /current operation/);
    await heldSessionControls(api);
    await request({ type: 'queuePrompt', text: 'MUST_NOT_RUN_AFTER_ROOT_TRANSITION' });
    if (action === 'roots') await changeAdditionalRoot(fixture.extra);
    else await request({ type: action === 'stop' ? 'cancel' : 'disconnect' });
    await rootDeadline(Promise.allSettled([running]));
    await rootDeadline(observer.ended);
    assert.equal(observer.count(), 1);
    assert.equal(controlClosed, false);
    assert.equal(api.status()!.busy, false);
    assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
    assert.equal(api.status()!.queued.length, 0);
    assert.ok(
      isDeepStrictEqual(await providerContext(), before),
      `Provider context changed during native ${action}; content withheld.`,
    );
    assert.deepEqual(api.status()!.changes, changes);
    for (const { document, text } of dirty) {
      assert.equal(document.getText(), text);
      assert.equal(document.isDirty, true);
    }
    console.log(
      `PASS: native ${action} cancels production PTY takeover, blocks session/permission switching, clears follow-ups and preserves unrelated terminal/dirty review state.`,
    );
  } finally {
    await request({ type: 'cancel' });
    if (running) await Promise.allSettled([running]);
    await request({ type: 'disconnect' });
    observer.dispose();
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) await changeAdditionalRoot();
    await fixture.restore();
    control.dispose();
    controlWrites.dispose();
  }
}

async function nativeStartupRoot(api: Api, root: vscode.Uri) {
  const request = (message: object) => api.request!({ v: 1, ...message });
  const fixture = await rootTransitionEnvironment(root);
  const previous = process.env.VS_OMP_FIXTURE_START_GATE;
  const gate = vscode.Uri.joinPath(root, 'startup-root-release').fsPath;
  process.env.VS_OMP_FIXTURE_START_GATE = gate;
  let connecting: Promise<void> | undefined;
  try {
    await changeAdditionalRoot(fixture.extra);
    const target = vscode.Uri.joinPath(fixture.extra, 'startup-root.txt');
    await vscode.workspace.fs.writeFile(target, Buffer.from('STARTUP_ROOT_FIXTURE'));
    await vscode.window.showTextDocument(target);
    const before = api.storedState!();
    const ready = fileSignal(`${gate}.ready`);
    connecting = request({ type: 'new' });
    void connecting.catch(() => {});
    await rootDeadline(
      Promise.race([
        ready,
        connecting.then(() => {
          throw new Error('Startup did not hold.');
        }),
      ]),
    );
    const pid = Number(await readFile(process.env.VS_OMP_FIXTURE_PID!, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 1);
    await changeAdditionalRoot();
    await writeFile(gate, 'release', { mode: 0o600 });
    await assert.rejects(rootDeadline(connecting), /workspace root changed during connection/);
    assert.equal(api.status()!.connected, false);
    assert.equal(api.status()!.connecting, false);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(api.storedState!(), before);
    await request({ type: 'new' });
    assert.equal(api.status()!.connected, true);
    console.log(
      'PASS: native root removal during held OMP startup rejects and reaps only the owned process, preserves state and permits a fresh valid connection.',
    );
  } finally {
    await writeFile(gate, 'release', { mode: 0o600 });
    if (connecting) await Promise.allSettled([connecting]);
    await request({ type: 'disconnect' });
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) await changeAdditionalRoot();
    if (previous === undefined) delete process.env.VS_OMP_FIXTURE_START_GATE;
    else process.env.VS_OMP_FIXTURE_START_GATE = previous;
    await fixture.restore();
  }
}

export async function nativeChat(api: Api, root: vscode.Uri): Promise<void> {
  const request = (message: object) => api.request!({ v: 1, ...message });
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await repositoryReadout(api, request, root);
  await hunkReview(api, request, root);
  assert.match(
    JSON.stringify((await providerContext()).systemPrompt),
    /VS_OMP_INSTRUCTION_DISCOVERY_SENTINEL/,
  );
  console.log(
    'PASS: production OMP launch discovers workspace AGENTS.md from disk without implicit editor attachments.',
  );
  await multipleContext(api, request);
  await queuedPrompts(api, request);
  await (await import('./ux.integration.js')).nativeUX(api, root);
  await nativeCompaction(api, root);
  for (const action of ['roots', 'stop', 'disconnect'] as const)
    await nativeHandoffTransition(api, root, action);
  await nativeStartupRoot(api, root);
}
