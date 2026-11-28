import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { setTimeout as delay } from 'node:timers/promises';

export interface DocsContext {
  extension: vscode.Extension<unknown> & { exports: Record<string, any> };
  root: vscode.Uri;
}

export async function waitForDocsCapture({ extension, root }: DocsContext): Promise<void> {
  await vscode.commands.executeCommand('omp.newSession');
  for (let attempt = 0; attempt < 200 && !extension.exports.status().connected; attempt += 1)
    await delay(50);
  assert.ok(extension.exports.status().connected, 'Docs capture must connect to OMP.');
  await extension.exports.request({
    v: 1,
    type: 'config',
    id: 'model',
    value: 'vs-omp-fixture/history',
  });
  const ready = process.env.VS_OMP_DOCS_READY;
  const done = process.env.VS_OMP_DOCS_DONE;
  assert.ok(ready && done, 'Docs capture requires ready and done signals.');
  await writeFile(ready, 'ready', { mode: 0o600 });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await readFile(done, 'utf8').catch(() => '')) return;
    await delay(100);
  }
  throw new Error(`Docs capture did not finish for ${root.fsPath}.`);
}
