import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HostTools } from '../host-tools.js';
import { PathGuard, ReviewJournal } from '../review.js';
import { WorkspaceFiles } from '../workspace.js';
import { nativeManagedWait, nativeSession } from './native-session.js';
import { ChatView } from '../chat-view.js';
import { webviewMessage } from '../state.js';
import { askQuestions } from '../host-questions.js';
import { questionRequest } from '../question-policy.js';

function fileSignal(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(target), (_event, fileName) => {
      if (fileName === path.basename(target)) void inspect();
    });
    const timer = setTimeout(
      () => finish(new Error(`Native UI signal missing: ${path.basename(target)}`)),
      30_000,
    );
    function finish(error?: unknown) {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    }
    async function inspect() {
      try {
        await readFile(target);
        finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error);
      }
    }
    watcher.once('error', finish);
    void inspect();
  });
}

async function dialogPhase(cwd: string, scenario: string, phase: string) {
  await writeFile(
    path.join(cwd, 'native-dialog-phase.json'),
    JSON.stringify({ scenario, phase, time: Date.now() }),
    { mode: 0o600 },
  );
}

async function dialogCase(tools: HostTools, cwd: string, scenario: string): Promise<void> {
  await dialogPhase(cwd, scenario, 'starting');
  const abort = new AbortController();
  const marker = path.join(cwd, `native-${scenario}.txt`);
  const session = await nativeSession(tools, cwd, scenario, abort);
  const running = scenario.endsWith('-running') ? fileSignal(marker) : undefined;
  const stopped =
    scenario === 'cancel-late'
      ? fileSignal(path.join(cwd, 'native-cancel')).then(() => abort.abort())
      : Promise.resolve();
  const execution = tools.run(
    {
      sessionId: session.client.sessionId!,
      owner: 'native-review',
      cwd,
      signal: abort.signal,
      valid: () => true,
    },
    () => session.prompt(),
  );
  try {
    if (scenario === 'approve') {
      await execution;
      assert.equal(await readFile(marker, 'utf8'), 'executed');
    } else if (running) {
      const rejected = assert.rejects(execution);
      await running;
      const pid = Number(await readFile(marker, 'utf8'));
      assert.ok(Number.isInteger(pid) && pid > 1);
      if (scenario === 'stop-running') {
        abort.abort();
        await session.client.cancel();
      } else if (scenario === 'disconnect-running') await session.client.stop();
      else process.kill(session.pid, 'SIGKILL');
      await dialogPhase(cwd, scenario, 'interrupted');
      await rejected;
      await dialogPhase(cwd, scenario, 'settled');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } else {
      await assert.rejects(execution);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally {
    await dialogPhase(cwd, scenario, 'cleanup');
    await session.client.stop();
    await dialogPhase(cwd, scenario, 'closed');
  }
  await stopped;
  if (scenario === 'cancel-late') await writeFile(path.join(cwd, 'native-cancelled'), 'cancelled');
  console.log(`PASS: real inline approval ${scenario} preserves command-specific approval.`);
}

async function approvalView(context: vscode.ExtensionContext): Promise<ChatView> {
  const output = vscode.window.createOutputChannel('OMP Native Approval Fixture');
  const chat = new ChatView(
    {
      subscriptions: context.subscriptions,
      extensionUri: vscode.Uri.file(process.env.VS_OMP_NATIVE_EXTENSION_ROOT!),
    },
    output,
    () => ({
      connected: true,
      busy: true,
      cancellable: true,
      host: 'Local',
      workspace: 'native-workspace',
      session: 'Native approval acceptance',
      sessionId: 'native-approval-fixture',
      turns: [],
      changes: [],
      configs: [],
      ...chat.approvals.snapshot(),
    }),
    async (message) => {
      await chat.localAction(webviewMessage.parse(message));
    },
  );
  const ready = new Promise<void>((resolve) => {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('native-approvals.chat', {
        resolveWebviewView: (view) => {
          chat.resolve(view);
          resolve();
        },
      }),
    );
  });
  context.subscriptions.push(output, { dispose: () => chat.dispose() });
  await vscode.commands.executeCommand('native-approvals.chat.focus');
  await ready;
  return chat;
}

async function policyCase(
  tools: HostTools,
  cwd: string,
  command: string,
  rejected = false,
): Promise<void> {
  const abort = new AbortController();
  const session = await nativeSession(tools, cwd, 'policy', abort, command);
  try {
    const execution = tools.run(
      {
        sessionId: session.client.sessionId!,
        owner: 'native-review',
        cwd,
        signal: abort.signal,
        valid: () => true,
      },
      () => session.prompt(),
    );
    if (rejected) await assert.rejects(execution);
    else await execution;
  } finally {
    await session.client.stop();
  }
}

async function yoloCases(tools: HostTools, cwd: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('omp');
  await tools.pickPermissions();
  assert.equal(tools.permissions, 'all');
  await tools.pickPermissions();
  assert.equal(tools.permissions, 'yolo');
  await policyCase(
    tools,
    cwd,
    'printf NATIVE_TERMINAL_OUTPUT > yolo-native-output.txt; cat yolo-native-output.txt',
  );
  assert.equal(
    Buffer.from(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(vscode.Uri.file(cwd), 'yolo-native-output.txt'),
      ),
    ).toString('utf8'),
    'NATIVE_TERMINAL_OUTPUT',
  );
  await policyCase(tools, cwd, 'wipefs --help', true);
  await config.update(
    'permissions.commandRules',
    [{ command: ['printf'], action: 'deny' }],
    vscode.ConfigurationTarget.Global,
  );
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT', true);
  await config.update(
    'permissions.commandRules',
    [{ command: ['printf'], action: 'ask' }],
    vscode.ConfigurationTarget.Global,
  );
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT', true);
  console.log(
    'PASS: installed OMP YOLO cancellation, confirmation, shell redirection, known-danger deny and explicit deny/ask.',
  );
}

async function permissionCases(tools: HostTools, cwd: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('omp');
  await policyCase(tools, cwd, 'pwd');
  await config.update(
    'permissions.commandRules',
    [{ command: ['printf', 'NATIVE_TERMINAL_OUTPUT'], action: 'allow', match: 'exact' }],
    vscode.ConfigurationTarget.Global,
  );
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT');
  await config.update('permissions.commandRules', [], vscode.ConfigurationTarget.Global);
  await tools.pickPermissions();
  assert.equal(tools.permissions, 'all');
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT');
  await config.update(
    'permissions.commandRules',
    [{ command: ['printf'], action: 'deny' }],
    vscode.ConfigurationTarget.Global,
  );
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT', true);
  await config.update(
    'permissions.commandRules',
    [{ command: ['printf'], action: 'ask' }],
    vscode.ConfigurationTarget.Global,
  );
  await policyCase(tools, cwd, 'printf NATIVE_TERMINAL_OUTPUT', true);
  await config.update('permissions.commandRules', [], vscode.ConfigurationTarget.Global);
  await yoloCases(tools, cwd);
  await config.update('permissions.commandRules', [], vscode.ConfigurationTarget.Global);
  await tools.pickPermissions();
  assert.equal(tools.permissions, 'rules');
  console.log(
    'PASS: installed OMP command rules, Allow All exceptions and native permission revocation.',
  );
}

async function questionCases(cwd: string): Promise<void> {
  const ask = async (header: string, extra = {}) =>
    JSON.parse(
      await askQuestions(
        questionRequest.parse({
          questions: [
            {
              header,
              question: 'Choose the fixture answer',
              allowFreeformInput: false,
              options: [{ label: 'JSON' }, { label: 'Text' }],
              ...extra,
            },
          ],
        }),
        new AbortController().signal,
      ),
    );
  const single = await ask('Parity Choice');
  assert.deepEqual(single.answers['Parity Choice'].selected, ['JSON']);
  const many = await ask('Parity Many', {
    multiSelect: true,
    options: [{ label: 'Diagnostics' }, { label: 'References' }, { label: 'Tests' }],
  });
  assert.deepEqual(many.answers['Parity Many'].selected, ['Diagnostics', 'Tests']);
  const text = await ask('Parity Text', { options: null, allowFreeformInput: true });
  assert.equal(text.answers['Parity Text'].freeText, 'Exact native user answer');
  assert.equal((await ask('Parity Dismiss')).status, 'cancelled');
  const abort = new AbortController();
  const stopped = fileSignal(path.join(cwd, 'native-question-stop')).then(() =>
    abort.abort(new Error('Stopped native question')),
  );
  const rejected = assert.rejects(
    askQuestions(
      questionRequest.parse({
        questions: [
          {
            header: 'Parity Stop',
            question: 'Stop this question',
            options: [{ label: 'Never choose this' }],
            allowFreeformInput: false,
          },
        ],
      }),
      abort.signal,
    ),
    /Stopped native question/,
  );
  await stopped;
  await rejected;
  console.log('PASS: native question choices, multiple selection, text, dismissal and Stop.');
}

async function runNativeDialogs(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  await vscode.workspace
    .getConfiguration('window')
    .update('dialogStyle', 'custom', vscode.ConfigurationTarget.Global);
  const files = new WorkspaceFiles(root);
  const journal = new ReviewJournal(
    files,
    new PathGuard([root.fsPath]),
    async () => false,
    async () => {},
  );
  const chat = await approvalView(context);
  const tools = new HostTools(
    files,
    journal,
    path.join(root.fsPath, '.native-private', 'mutations'),
    (prompt, signal, valid) => {
      const request = chat.requestApproval(prompt, signal, valid);
      const id = chat.approvals.snapshot().approval?.id;
      if (id && prompt.details.includes('native-cancel-late.txt'))
        signal.addEventListener('abort', () => chat.approvals.decide(id, true), { once: true });
      return request;
    },
  );
  const protectedFile = path.join(root.fsPath, 'native-protected.txt');
  await writeFile(protectedFile, 'user baseline\n');
  await journal.write('native-review', protectedFile, 'pending reviewed change\n');
  const pending = structuredClone(journal.list());
  const dirty = await vscode.workspace.openTextDocument({ content: 'unsaved native baseline' });
  const edit = new vscode.WorkspaceEdit();
  edit.insert(dirty.uri, dirty.positionAt(0), 'dirty ');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const dirtyText = dirty.getText();
  try {
    for (const scenario of ['stop', 'disconnect', 'exit', 'complete'] as const) {
      await nativeManagedWait(root.fsPath, files, journal, scenario);
      assert.deepEqual(journal.list(), pending);
      assert.equal(await readFile(protectedFile, 'utf8'), 'pending reviewed change\n');
      assert.equal(dirty.getText(), dirtyText);
      assert.ok(dirty.isDirty);
    }
    await writeFile(path.join(root.fsPath, 'native-ui-ready'), 'ready');
    await questionCases(root.fsPath);
    await permissionCases(tools, root.fsPath);
    for (const scenario of [
      'reject',
      'escape',
      'menu',
      'approve',
      'reject-again',
      'cancel-late',
      'stop-running',
      'disconnect-running',
      'exit-running',
    ]) {
      await dialogCase(tools, root.fsPath, scenario);
      assert.deepEqual(journal.list(), pending);
      assert.equal(await readFile(protectedFile, 'utf8'), 'pending reviewed change\n');
      assert.equal(dirty.getText(), dirtyText);
      assert.ok(dirty.isDirty);
    }
    await fileSignal(path.join(root.fsPath, 'native-ui-done'));
    console.log(
      'PASS: native inline approvals leave dirty buffers and pending review ownership unchanged.',
    );
  } finally {
    await tools.finish();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const result = process.env.VS_OMP_NATIVE_UI_RESULTS;
  if (!result) throw new Error('Native UI fixture requires a disposable result path.');
  void runNativeDialogs(context).then(
    () => writeFile(result, JSON.stringify({ ok: true })),
    (error: unknown) =>
      writeFile(
        result,
        JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }),
      ),
  );
}
