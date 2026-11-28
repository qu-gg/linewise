import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { nativeMutationFiles, nativeWorkspaceFiles } from './native-files.js';
import { waitForDocsCapture } from './docs.integration.js';
import { retryLastTurn } from './retry.integration.js';
import { nativeChat } from './chat.integration.js';
import { prepareUXReopen, verifyUXReopen } from './ux.integration.js';
import { inspectEditor } from '../host-inspect.js';
import { editorRequest } from '../editor-policy.js';
import { renameWorkspace } from '../host-rename.js';
import { renameRequest } from '../rename-policy.js';
import { ReviewJournal, PathGuard } from '../review.js';
import { WorkspaceFiles } from '../workspace.js';
import { nativeReviewedCodeAction } from './code-actions.integration.js';
import { nativeSessionTools } from './browser-session.integration.js';
import {
  nativeInstalledOnboarding,
  nativeOnboarding,
  nativeStorageInspection,
} from './onboarding.integration.js';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('vs-omp-local.vs-omp');
  assert.ok(extension, 'OMP extension must be discoverable');
  if (process.env.VS_OMP_EXPECTED_EXTENSION_PATH) {
    assert.equal(
      await realpath(extension.extensionPath),
      process.env.VS_OMP_EXPECTED_EXTENSION_PATH,
    );
    console.log('PASS: actual registry-installed OMP package is selected, not a development copy.');
  }
  await extension.activate();
  assert.equal(extension.isActive, true);
  await vscode.commands.executeCommand('omp.open');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  if (process.env.VS_OMP_DOCS_CAPTURE === '1') return waitForDocsCapture({ extension, root });
  if (process.env.VS_OMP_EXPECTED_EXTENSION_PATH) return nativeInstalledOnboarding(root);
  if (process.env.VS_OMP_UX_REOPEN === '1') return verifyUXReopen(extension.exports, root);
  await nativeOnboarding(extension.exports, root);
  await nativeStorageInspection(extension.exports);
  await nativeReviewedRename(root);
  await nativeReviewedCodeAction(root);
  await nativeEditorResources(root);
  await nativeSessionTools(root, extension.exports);
  await nativeWorkspaceFiles(root);
  await vscode.commands.executeCommand('omp.newSession');
  const status = extension.exports.status();
  assert.ok(status.connected, status.error || 'Native extension must connect to OMP');
  assert.ok(status.configs.some((option: { id: string }) => option.id === 'model'));
  console.log(
    'PASS: the real extension host launches OMP and discovers authenticated model controls.',
  );
  const dispatch = extension.exports.request as (message: unknown) => Promise<void>;
  assert.equal(typeof dispatch, 'function');
  const request = async (message: unknown) => {
    try {
      await dispatch(message);
    } catch (error) {
      console.error(
        'REQUEST_FAILURE',
        JSON.stringify({
          message,
          details: error instanceof Error && 'data' in error ? error.data : String(error),
        }),
      );
      throw error;
    }
  };
  const prepared = await prepareHistory({ extension, root, request, dispatch });
  const edited = await editHistory(prepared);
  await firstFork(edited);
  const archive = await reopenBranches(edited);
  await operationGates({ ...prepared, archive });
  await retryLastTurn(prepared);
  await nativeMutationFiles(extension.exports, root);
  await nativeChat(extension.exports, root);
  await prepareUXReopen(extension.exports, root);
}

async function nativeReviewedRename(root: vscode.Uri): Promise<void> {
  const source = vscode.Uri.joinPath(root, 'rename-source.ts');
  const usage = vscode.Uri.joinPath(root, 'rename-usage.ts');
  const before = [
    'export const rate = 7;\n',
    'import {rate} from "./rename-source";\nexport const quote = rate * 3;\n',
  ];
  const provider = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(provider);
  await provider.activate();
  const files = new WorkspaceFiles(root);
  let persisted = '[]';
  const journal = new ReviewJournal(
    files,
    new PathGuard([root.fsPath]),
    async () => false,
    async (changes) => {
      persisted = JSON.stringify(changes);
    },
  );
  try {
    await vscode.workspace.fs.writeFile(source, Buffer.from(before[0]!));
    await vscode.workspace.fs.writeFile(usage, Buffer.from(before[1]!));
    await vscode.window.showTextDocument(source);
    await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', source);
    const input = renameRequest.parse({
      path: source.fsPath,
      line: 1,
      column: 14,
      newName: 'shippingRate',
      paths: [source.fsPath, usage.fsPath],
    });
    const scope = {
      cwd: root.fsPath,
      privateRoot: path.join(root.fsPath, '.rename-private'),
      signal: new AbortController().signal,
      valid: () => true,
    };
    const result = JSON.parse(
      await renameWorkspace(input, scope, (image) =>
        journal.write('native-rename', image.path, image.content, scope.signal, image.before, {
          tool: 'rename',
        }),
      ),
    );
    assert.equal(result.completed, 2);
    assert.match((await files.read(source.fsPath))!, /export const shippingRate/);
    assert.match((await files.read(usage.fsPath))!, /shippingRate \* 3/);
    const reopened = new ReviewJournal(
      files,
      new PathGuard([root.fsPath]),
      async () => false,
      async () => {},
      JSON.parse(persisted),
    );
    for (const change of reopened.list()) await reopened.discard(change.id);
    assert.equal(await files.read(source.fsPath), before[0]);
    assert.equal(await files.read(usage.fsPath), before[1]);
    console.log(
      'PASS: native TypeScript cross-file rename enters durable review and Discard restores both files.',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(source, { recursive: false, useTrash: false });
    await vscode.workspace.fs.delete(usage, { recursive: false, useTrash: false });
  }
}

const nativeNotebookPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  'base64',
);

function nativeNotebookData(): vscode.NotebookData {
  const cell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    'ORIGINAL_NOTEBOOK_CELL',
    'plaintext',
  );
  cell.outputs = [
    new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text('Native text output'),
      new vscode.NotebookCellOutputItem(nativeNotebookPng, 'image/png'),
    ]),
  ];
  return new vscode.NotebookData([cell]);
}

async function nativeNotebookImage(
  uri: vscode.Uri,
  scope: Parameters<typeof inspectEditor>[1],
): Promise<void> {
  const image = JSON.parse(
    await inspectEditor(
      editorRequest.parse({
        action: 'notebookImage',
        path: uri.fsPath,
        cell: 1,
        output: 1,
        item: 2,
      }),
      scope,
    ),
  );
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.untrusted, true);
  assert.deepEqual(Buffer.from(image.data, 'base64'), nativeNotebookPng);
  console.log(
    'PASS: native notebook output image is returned exactly without kernel execution or notebook mutation.',
  );
}

async function nativeEditorResources(root: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(root, 'parity.ompnotebook');
  const data = nativeNotebookData();
  const serializer = vscode.workspace.registerNotebookSerializer('omp-parity-fixture', {
    deserializeNotebook: () => data,
    serializeNotebook: () => new TextEncoder().encode('fixture notebook'),
  });
  const provider = vscode.tasks.registerTaskProvider('omp-parity-fixture', {
    provideTasks: () => [
      new vscode.Task(
        { type: 'omp-parity-fixture' },
        vscode.workspace.workspaceFolders![0]!,
        'Parity Read-Only Task',
        'parity-fixture',
        new vscode.ProcessExecution(process.execPath, ['--version']),
      ),
    ],
    resolveTask: () => undefined,
  });
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('fixture notebook'));
    const notebook = await vscode.workspace.openNotebookDocument('omp-parity-fixture', data);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'omp-parity-fixture');
    const opened = vscode.workspace.notebookDocuments.find(
      (item) => item.uri.toString() === uri.toString(),
    )!;
    assert.ok(opened);
    const cell = opened.cellAt(0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      cell.document.uri,
      new vscode.Range(
        new vscode.Position(0, 0),
        cell.document.positionAt(cell.document.getText().length),
      ),
      'UNSAVED_NATIVE_NOTEBOOK_CELL',
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    const scope = {
      cwd: root.fsPath,
      privateRoot: path.join(root.fsPath, '.private-resource-fixture'),
      signal: new AbortController().signal,
    };
    const result = JSON.parse(
      await inspectEditor(editorRequest.parse({ action: 'notebook', path: uri.fsPath }), scope),
    );
    assert.equal(result.items[0].text, 'UNSAVED_NATIVE_NOTEBOOK_CELL');
    assert.equal(result.items[0].dirty, true);
    assert.equal(result.items[0].outputs[1].item, 2);
    await nativeNotebookImage(uri, scope);
    const tasks = JSON.parse(await inspectEditor(editorRequest.parse({ action: 'tasks' }), scope));
    assert.ok(tasks.items.some((item: { name: string }) => item.name === 'Parity Read-Only Task'));
    assert.equal(notebook.cellCount, 1);
    console.log(
      'PASS: native public notebook inspection preserves unsaved cells and task discovery does not execute.',
    );
  } finally {
    provider.dispose();
    serializer.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(uri);
  }
}

interface NativeCase {
  extension: vscode.Extension<unknown> & { exports: Record<string, any> };
  root: vscode.Uri;
  request: (message: unknown) => Promise<void>;
  dispatch: (message: unknown) => Promise<void>;
}

async function prepareHistory({ extension, root, request, dispatch }: NativeCase) {
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'PAST_SENTINEL WRITE_FIXTURE' });
  const writeTurn = extension.exports.status().turns.at(-1);
  assert.ok(
    writeTurn.blocks.some(
      (block: { kind: string; status: string }) =>
        block.kind === 'tool' && block.status === 'completed',
    ),
    JSON.stringify(writeTurn),
  );
  assert.equal(await readFile(path.join(root.fsPath, 'history.txt'), 'utf8'), 'agent version\n');
  const attachment = await vscode.workspace.openTextDocument({
    content: 'ATTACHMENT_ORIGINAL',
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(attachment);
  await request({ v: 1, type: 'attach' });
  await request({ v: 1, type: 'prompt', text: 'FUTURE_SENTINEL' });
  const attachmentEdit = new vscode.WorkspaceEdit();
  attachmentEdit.replace(
    attachment.uri,
    new vscode.Range(attachment.positionAt(0), attachment.positionAt(attachment.getText().length)),
    'ATTACHMENT_CHANGED',
  );
  assert.ok(await vscode.workspace.applyEdit(attachmentEdit));
  const originalId = extension.exports.status().sessionId;
  const pending = extension.exports.storedState().changes;
  assert.equal(pending.length, 1);
  const untouched = await vscode.workspace.openTextDocument({
    content: 'unsaved unrelated work',
    language: 'plaintext',
  });
  const untouchedEdit = new vscode.WorkspaceEdit();
  untouchedEdit.insert(untouched.uri, untouched.positionAt(0), 'dirty ');
  assert.ok(await vscode.workspace.applyEdit(untouchedEdit));
  const untouchedText = untouched.getText();
  const edited = extension.exports.status().turns[1];
  const contextPath = process.env.VS_OMP_FIXTURE_CONTEXT;
  assert.ok(contextPath);
  return {
    extension,
    root,
    request,
    dispatch,
    untouched,
    untouchedText,
    edited,
    contextPath,
    originalId,
    pending,
    writeTurn,
  };
}

async function editHistory(prepared: Awaited<ReturnType<typeof prepareHistory>>) {
  const {
    extension,
    root,
    request,
    untouched,
    untouchedText,
    edited,
    contextPath,
    originalId,
    pending,
  } = prepared;
  assert.ok(edited.history, 'New turns must capture canonical native entry IDs');
  await request({ v: 1, type: 'editPrompt', id: edited.id, text: 'REPLACEMENT_SENTINEL' });
  const editedStatus = extension.exports.status();
  assert.equal(editedStatus.sessionId, originalId);
  assert.equal(editedStatus.turns.length, 2);
  assert.equal(editedStatus.turns[1].prompt, 'REPLACEMENT_SENTINEL');
  assert.deepEqual(extension.exports.storedState().changes, pending);
  assert.equal(await readFile(path.join(root.fsPath, 'history.txt'), 'utf8'), 'agent version\n');
  assert.equal(untouched.getText(), untouchedText);
  assert.ok(untouched.isDirty);
  const editedContext = JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages);
  assert.ok(editedContext.includes('PAST_SENTINEL'));
  assert.ok(editedContext.includes('REPLACEMENT_SENTINEL'));
  assert.ok(!editedContext.includes('FUTURE_SENTINEL'));
  assert.ok(editedContext.includes('ATTACHMENT_ORIGINAL'));
  assert.ok(!editedContext.includes('ATTACHMENT_CHANGED'));
  const archive = extension.exports
    .storedState()
    .sessions.find(
      (saved: { id: string; turns: { prompt: string }[] }) =>
        saved.id !== originalId &&
        saved.turns.some((current) => current.prompt === 'FUTURE_SENTINEL'),
    );
  assert.ok(archive);
  console.log(
    'PASS: editing rewinds real model context, archives the original, and preserves files, dirty buffers and pending review ownership.',
  );
  return { ...prepared, editedStatus, archive };
}

async function firstFork({
  extension,
  root,
  request,
  originalId,
  pending,
  contextPath,
  editedStatus,
}: Awaited<ReturnType<typeof editHistory>>) {
  await request({ v: 1, type: 'forkTurn', id: editedStatus.turns[0].id, boundary: 'before' });
  assert.notEqual(extension.exports.status().sessionId, originalId);
  assert.equal(extension.exports.status().turns.length, 0);
  assert.deepEqual(extension.exports.storedState().changes, pending);
  await request({ v: 1, type: 'prompt', text: 'FORK_SENTINEL' });
  const immediateContext = JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages);
  assert.ok(
    !immediateContext.includes('PAST_SENTINEL'),
    'The original prompt must be absent from forked conversation messages.',
  );
  await request({ v: 1, type: 'disconnect' });
  await request({ v: 1, type: 'connect' });
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'RESUMED_SENTINEL' });
  const forkContext = JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages);
  assert.ok(forkContext.includes('FORK_SENTINEL'));
  for (const excluded of ['PAST_SENTINEL', 'FUTURE_SENTINEL', 'REPLACEMENT_SENTINEL'])
    assert.ok(!forkContext.includes(excluded), excluded);
  assert.deepEqual(extension.exports.storedState().changes, pending);
  assert.equal(await readFile(path.join(root.fsPath, 'history.txt'), 'utf8'), 'agent version\n');
  console.log(
    'PASS: a first-prompt fork excludes the original conversation, survives process restart, and never transfers pending review ownership.',
  );
}

async function reopenBranches({
  extension,
  root,
  request,
  originalId,
  pending,
  contextPath,
  writeTurn,
  archive,
}: Awaited<ReturnType<typeof editHistory>>) {
  const resumed = extension.exports.status();
  await request({ v: 1, type: 'forkTurn', id: resumed.turns[0].id, boundary: 'after' });
  assert.notEqual(extension.exports.status().sessionId, resumed.sessionId);
  assert.equal(extension.exports.status().turns.length, 1);
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'AFTER_FORK_SENTINEL' });
  const afterContext = JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages);
  assert.ok(afterContext.includes('FORK_SENTINEL'));
  assert.ok(!afterContext.includes('RESUMED_SENTINEL'));
  await extension.exports.resume(originalId, true);
  assert.equal(extension.exports.status().changes.length, 1);
  await request({ v: 1, type: 'forkTurn', id: writeTurn.id, boundary: 'after' });
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'PAIRED_HISTORY_CHECK' });
  const paired = JSON.parse(await readFile(contextPath, 'utf8')).messages;
  assert.ok(paired.some((message: { role: string }) => message.role === 'toolResult'));
  assert.ok(
    paired.some(
      (message: { role: string; content?: { type: string }[] }) =>
        message.role === 'assistant' &&
        message.content?.some((content) => content.type === 'toolCall'),
    ),
  );
  assert.ok(!JSON.stringify(paired).includes('REPLACEMENT_SENTINEL'));
  assert.ok(archive.label.endsWith('(before edit)'));
  await extension.exports.resume(archive.id);
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'ARCHIVE_CHECK' });
  const archived = JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages);
  assert.ok(archived.includes('FUTURE_SENTINEL'));
  assert.ok(!archived.includes('REPLACEMENT_SENTINEL'));
  assert.deepEqual(extension.exports.storedState().changes, pending);
  assert.equal(await readFile(path.join(root.fsPath, 'history.txt'), 'utf8'), 'agent version\n');
  console.log(
    'PASS: forks after reconnect use live handles, retain complete tool pairs, preserve attachment snapshots, and archived originals reopen independently.',
  );
  return archive;
}

async function operationGates({
  extension,
  request,
  dispatch,
  pending,
  contextPath,
  archive,
}: Awaited<ReturnType<typeof prepareHistory>> & {
  archive: Awaited<ReturnType<typeof reopenBranches>>;
}) {
  const running = dispatch({ v: 1, type: 'prompt', text: 'OPERATION_GATE_CHECK' });
  const conflicts = await Promise.allSettled([
    dispatch({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' }),
    dispatch({ v: 1, type: 'forkTurn', id: archive.turns[0].id, boundary: 'before' }),
    dispatch({ v: 1, type: 'keepAll' }),
    dispatch({ v: 1, type: 'new' }),
  ]);
  for (const result of conflicts) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(String(result.reason), /current operation/);
  }
  await running;
  const cancelled = dispatch({ v: 1, type: 'prompt', text: 'CANCEL_BEFORE_SEND' });
  await dispatch({ v: 1, type: 'cancel' });
  await cancelled;
  assert.equal(extension.exports.status().turns.at(-1).status, 'cancelled');
  assert.ok(
    !JSON.stringify(JSON.parse(await readFile(contextPath, 'utf8')).messages).includes(
      'CANCEL_BEFORE_SEND',
    ),
  );
  assert.deepEqual(extension.exports.storedState().changes, pending);
  console.log(
    'PASS: operation ownership refuses overlapping config/review/history/session changes and cancellation before send never reaches the model.',
  );
  await request({ v: 1, type: 'new' });
  const emptyId = extension.exports.status().sessionId;
  await request({ v: 1, type: 'disconnect' });
  await request({ v: 1, type: 'connect' });
  assert.equal(extension.exports.status().sessionId, emptyId);
  assert.equal(extension.exports.status().turns.length, 0);
  await request({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ v: 1, type: 'prompt', text: 'EMPTY_SESSION_RESTART' });
  assert.equal(extension.exports.status().turns.at(-1).status, 'completed');
  console.log(
    'PASS: legacy native filenames are recovered and empty sessions reconnect without losing their local identity.',
  );
}
