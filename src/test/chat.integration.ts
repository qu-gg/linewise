import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeCompaction } from './compaction.integration.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Request = (message: object) => Promise<void>;

async function providerContext() {
  assert.ok(process.env.VS_OMP_FIXTURE_CONTEXT);
  return JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT, 'utf8'));
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

export async function nativeChat(api: Api, root: vscode.Uri): Promise<void> {
  const request = (message: object) => api.request!({ v: 1, ...message });
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
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
  await nativeCompaction(api, root);
}
