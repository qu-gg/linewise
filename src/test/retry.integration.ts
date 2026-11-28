import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';

export interface RetryContext {
  extension: vscode.Extension<unknown> & { exports: Record<string, any> };
  root: vscode.Uri;
  request: (message: unknown) => Promise<void>;
  contextPath: string;
  pending: unknown[];
}

export async function retryLastTurn({
  extension,
  root,
  request,
  contextPath,
  pending,
}: RetryContext): Promise<void> {
  await request({ v: 1, type: 'permissions', mode: 'yolo', confirmed: true });
  assert.equal(extension.exports.status().permissions, 'yolo');
  const sessionId = extension.exports.status().sessionId;
  const turns = extension.exports.status().turns.length;
  await request({ v: 1, type: 'prompt', text: 'RETRY_SENTINEL' });
  const target = extension.exports.status().turns.at(-1);
  assert.equal(target.status, 'completed');
  await request({ v: 1, type: 'retryTurn', id: target.id });
  const status = extension.exports.status();
  assert.equal(status.sessionId, sessionId);
  assert.equal(status.permissions, 'yolo');
  assert.equal(status.turns.length, turns + 1);
  assert.equal(status.turns.at(-1).prompt, 'RETRY_SENTINEL');
  assert.equal(status.turns.at(-1).status, 'completed');
  assert.notEqual(status.turns.at(-1).id, target.id);
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(
    JSON.stringify(context.messages).match(/RETRY_SENTINEL/g)?.length ?? 0,
    1,
    'Retry must replace the last response instead of appending a duplicate prompt.',
  );
  assert.deepEqual(extension.exports.storedState().changes, pending);
  assert.equal(await readFile(path.join(root.fsPath, 'history.txt'), 'utf8'), 'agent version\n');
  await request({ v: 1, type: 'permissions', mode: 'rules' });
  assert.equal(extension.exports.status().permissions, 'rules');
  console.log(
    'PASS: retry rewinds the last completed response in place and keeps the active permission mode.',
  );
}
