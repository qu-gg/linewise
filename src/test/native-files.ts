import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, ReviewJournal } from '../review.js';
import { WorkspaceFiles } from '../workspace.js';

export async function nativeWorkspaceFiles(root: vscode.Uri): Promise<void> {
  const files = new WorkspaceFiles(root);
  const target = path.join(root.fsPath, 'buffer.txt');
  await writeFile(target, 'original\n');
  const document = await vscode.workspace.openTextDocument(files.uri(target));
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(document.getText().length), 'unsaved user work\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(document.isDirty);
  const journal = new ReviewJournal(
    files,
    new PathGuard([root.fsPath]),
    async () => false,
    async () => {},
  );
  const baseline = document.getText();
  await journal.write('test', target, 'agent result\n');
  assert.equal(document.getText(), 'agent result\n');
  assert.equal(await readFile(target, 'utf8'), 'agent result\n');
  await journal.discard(journal.list()[0]!.id);
  assert.equal(document.getText(), baseline);
  assert.equal(await readFile(target, 'utf8'), baseline);
  console.log(
    'PASS: native unsaved buffers are the baseline and Discard preserves pre-existing user work.',
  );
  const crlf = path.join(root.fsPath, 'crlf.txt');
  await writeFile(crlf, 'before\r\n');
  await journal.write('test', crlf, await files.normalize(crlf, 'after\n'));
  assert.equal(await readFile(crlf, 'utf8'), 'after\r\n');
  console.log('PASS: native editor writes preserve existing CRLF line endings.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-outside-'));
  try {
    const outside = path.join(temporary, 'open.txt');
    await writeFile(outside, 'private\n');
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(files.uri(outside)),
    );
    await assert.rejects(journal.write('test', outside, 'must not change\n'), /not approved/);
    assert.equal(await readFile(outside, 'utf8'), 'private\n');
    console.log(
      'PASS: an already-open outside-workspace tab still requires approval and remains unchanged on rejection.',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

interface NativeHost {
  request(message: unknown): Promise<void>;
  status(): { changes: { id: string; name: string }[] };
  storedState(): { changes: unknown[] };
}

export async function nativeMutationFiles(host: NativeHost, root: vscode.Uri): Promise<void> {
  const files = new WorkspaceFiles(root);
  const source = path.join(root.fsPath, 'probe.txt');
  for (const scenario of ['update', 'delete', 'move', 'editedmove']) {
    await files.replace(source, await files.read(source), 'before\n');
    const before = structuredClone(host.storedState().changes);
    await host.request({ v: 1, type: 'prompt', text: `NATIVE_MUTATION_FIXTURE ${scenario}` });
    const change = host.status().changes.find((item) => item.name.includes('probe.txt'));
    assert.ok(change, `Native ${scenario} must produce host-owned review.`);
    if (scenario === 'update') assert.equal(await readFile(source, 'utf8'), 'after\n');
    else await assert.rejects(readFile(source), { code: 'ENOENT' });
    if (scenario.includes('move')) {
      const destination = path.join(
        root.fsPath,
        scenario === 'move' ? 'moved.txt' : 'moved space.txt',
      );
      assert.equal(
        await readFile(destination, 'utf8'),
        scenario === 'move' ? 'before\n' : 'changed\n',
      );
      assert.match(change.name, / -> /);
    }
    await host.request({ v: 1, type: 'review', id: change.id });
    await host.request({ v: 1, type: 'discard', id: change.id });
    assert.equal(await readFile(source, 'utf8'), 'before\n');
    assert.deepEqual(host.storedState().changes, before);
  }
  for (const scenario of ['delete', 'move']) {
    const document = await vscode.workspace.openTextDocument(files.uri(source));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(0), 'dirty user work\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const pending = structuredClone(host.storedState().changes);
    const text = document.getText();
    await host.request({ v: 1, type: 'prompt', text: `NATIVE_MUTATION_FIXTURE ${scenario}` });
    assert.equal(await readFile(source, 'utf8'), 'before\n');
    assert.equal(document.getText(), text);
    assert.ok(document.isDirty);
    assert.deepEqual(host.storedState().changes, pending);
    await files.replace(source, text, 'before\n');
  }
  console.log(
    'PASS: real OMP native updates/deletes/edited renames use host review, preserve dirty buffers, and Discard restores open-file baselines.',
  );
}
