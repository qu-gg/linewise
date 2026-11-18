import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeMutationFiles, nativeWorkspaceFiles } from './native-files.js';
import { nativeChat } from './chat.integration.js';

async function nativeStorageInspection(
  api: Awaited<ReturnType<typeof import('../extension.js').activate>>,
) {
  const before = api.storedState!();
  await vscode.commands.executeCommand('omp.inspectStorage');
  const document = vscode.window.activeTextEditor!.document;
  assert.equal(document.uri.scheme, 'omp-storage');
  assert.notEqual(vscode.workspace.fs.isWritableFileSystem(document.uri.scheme), true);
  assert.equal(document.isDirty, false);
  const report = JSON.parse(document.getText());
  assert.equal(report.sessionCount, before.sessions.length);
  assert.equal(report.serializedStateBytes, Buffer.byteLength(JSON.stringify(before)));
  assert.equal(report.automaticDeletion, false);
  assert.equal(report.nativeArtifactSizes, 'regular-jsonl-only');
  await vscode.commands.executeCommand('omp.inspectStorage');
  assert.notEqual(vscode.window.activeTextEditor!.document.uri.toString(), document.uri.toString());
  assert.deepEqual(api.storedState!(), before);
  assert.notEqual(api.status()!.connected, true);
  console.log(
    'PASS: native storage inspection opens fresh read-only metadata without OMP or state changes.',
  );
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('vs-omp-local.vs-omp');
  assert.ok(extension, 'Development extension must be discoverable');
  await extension.activate();
  assert.equal(extension.isActive, true);
  await vscode.commands.executeCommand('omp.open');
  await nativeStorageInspection(extension.exports);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
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
  const archive = await reopenBranches(prepared);
  await operationGates({ ...prepared, archive });
  await nativeMutationFiles(extension.exports, root);
  await nativeChat(extension.exports, root);
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
  assert.ok(
    extension.exports
      .storedState()
      .sessions.some(
        (saved: { id: string; turns: { prompt: string }[] }) =>
          saved.id !== originalId &&
          saved.turns.some((current) => current.prompt === 'FUTURE_SENTINEL'),
      ),
  );
  console.log(
    'PASS: editing rewinds real model context, archives the original, and preserves files, dirty buffers and pending review ownership.',
  );
  return { ...prepared, editedStatus };
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
}: Awaited<ReturnType<typeof prepareHistory>>) {
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
  const archive = extension.exports
    .storedState()
    .sessions.find((saved: { label: string }) => saved.label.endsWith('(before edit)'));
  assert.ok(archive);
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
