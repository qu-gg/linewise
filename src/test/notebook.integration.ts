import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceFiles } from '../workspace.js';
import { ReviewJournal, PathGuard } from '../review.js';
import { HostTools } from '../host-tools.js';
import { exchangeResult } from '../mutations.js';

export async function notebookEditFixture(root: vscode.Uri, initial = 17) {
  const uri = vscode.Uri.joinPath(root, `review-${randomUUID()}.ipynb`);
  const before =
    JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          custom: randomUUID(),
          kernelspec: { name: 'python3', display_name: 'Unexecuted' },
        },
        cells: [
          {
            id: randomUUID(),
            cell_type: 'code',
            metadata: { tags: ['preserve'] },
            source: [`total = ${initial}\n`, 'print(total)\n'],
            execution_count: 7,
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['previous output\n'] }],
          },
        ],
      },
      null,
      2,
    ) + '\n';
  const original = JSON.parse(before);
  const serializer = vscode.workspace.registerNotebookSerializer('omp-parity-fixture', {
    deserializeNotebook: (bytes) => {
      const saved = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const data = new vscode.NotebookData(
        saved.cells.map((cell: (typeof original.cells)[number]) => {
          const data = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            Array.isArray(cell.source) ? cell.source.join('') : cell.source,
            'python',
          );
          data.metadata = { ...cell.metadata, id: cell.id, execution_count: cell.execution_count };
          data.outputs = [
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(cell.outputs[0].text.join('')),
            ]),
          ];
          return data;
        }),
      );
      data.metadata = saved.metadata;
      return data;
    },
    serializeNotebook: (data) =>
      Buffer.from(
        JSON.stringify({
          ...original,
          cells: data.cells.map((cell, index) => ({
            ...original.cells[index],
            source: cell.value,
          })),
        }),
      ),
  });
  await vscode.workspace.fs.writeFile(uri, Buffer.from(before));
  await vscode.commands.executeCommand('vscode.openWith', uri, 'omp-parity-fixture');
  const notebook = vscode.workspace.notebookDocuments.find(
    (item) => item.uri.toString() === uri.toString(),
  )!;
  assert.ok(notebook);
  return { uri, before, original, notebook, dispose: () => serializer.dispose() };
}

export async function currentCell(
  notebook: vscode.NotebookDocument,
  source: string,
): Promise<void> {
  if (notebook.cellAt(0).document.getText() === source) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error('Live notebook cell did not refresh.'));
    }, 10_000);
    const listener = vscode.workspace.onDidChangeNotebookDocument(() => {
      if (notebook.cellAt(0).document.getText() !== source) return;
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

export async function nativeReviewedNotebook(root: vscode.Uri): Promise<void> {
  const fixture = await notebookEditFixture(root);
  const privateRoot = vscode.Uri.joinPath(root, '.notebook-private');
  const directory = path.join(privateRoot.fsPath, 'mutations');
  await vscode.workspace.fs.createDirectory(privateRoot);
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
  const tools = new HostTools(files, journal, directory);
  const signal = AbortSignal.timeout(30_000);
  const scope = {
    sessionId: 'native-notebook',
    owner: 'native-notebook',
    cwd: root.fsPath,
    signal,
    valid: () => true,
  };
  const source = 'total = 23\nprint(total)\n';
  const request = {
    path: fixture.uri.fsPath,
    cell: 1,
    expectedSource: 'total = 17\nprint(total)\n',
    source,
  };
  try {
    await tools.run(scope, async () => {
      const result = JSON.parse(
        (await exchangeResult(directory, [{ op: 'notebook_edit', request }], signal))!,
      );
      assert.equal(result.completed, 1);
      assert.equal(result.review, 'pending');
    });
    await currentCell(fixture.notebook, source);
    assert.equal(
      Buffer.from(fixture.notebook.cellAt(0).outputs[0]!.items[0]!.data).toString(),
      'previous output\n',
    );
    assert.deepEqual(fixture.notebook.metadata, fixture.original.metadata);
    const edited = JSON.parse((await files.read(fixture.uri.fsPath))!);
    edited.cells[0].source = fixture.original.cells[0].source;
    assert.deepEqual(edited, fixture.original);
    const reopened = new ReviewJournal(
      files,
      new PathGuard([root.fsPath]),
      async () => false,
      async () => {},
      JSON.parse(persisted),
    );
    assert.equal(reopened.list()[0]!.operations![0]!.tool, 'notebook_edit');
    await reopened.discard(reopened.list()[0]!.id);
    assert.equal(await files.read(fixture.uri.fsPath), fixture.before);
    await currentCell(fixture.notebook, request.expectedSource);
    assert.equal(fixture.notebook.isDirty, false);
    console.log(
      'PASS: native reviewed notebook source refresh, preserved metadata/outputs, persisted provenance and exact Discard.',
    );
  } finally {
    await tools.finish();
    fixture.dispose();
  }
  await nativeDirtyNotebook(root);
}

async function nativeDirtyNotebook(root: vscode.Uri): Promise<void> {
  const fixture = await notebookEditFixture(root);
  const files = new WorkspaceFiles(root);
  const journal = new ReviewJournal(
    files,
    new PathGuard([root.fsPath]),
    async () => false,
    async () => {},
  );
  const directory = path.join(root.fsPath, '.notebook-dirty-private', 'mutations');
  const tools = new HostTools(files, journal, directory);
  const signal = AbortSignal.timeout(30_000);
  const scope = {
    sessionId: 'native-dirty-notebook',
    owner: 'native-dirty-notebook',
    cwd: root.fsPath,
    signal,
    valid: () => true,
  };
  const cell = fixture.notebook.cellAt(0).document;
  const edit = new vscode.WorkspaceEdit();
  const userSource = 'UNSAVED_USER_NOTEBOOK_WORK\n';
  edit.replace(
    cell.uri,
    new vscode.Range(new vscode.Position(0, 0), cell.positionAt(cell.getText().length)),
    userSource,
  );
  try {
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.equal(fixture.notebook.isDirty, true);
    const request = {
      path: fixture.uri.fsPath,
      cell: 1,
      expectedSource: userSource,
      source: 'must not write',
    };
    await tools.run(scope, async () => {
      await assert.rejects(
        exchangeResult(directory, [{ op: 'notebook_edit', request }], signal),
        /dirty notebook/,
      );
    });
    assert.equal(cell.getText(), userSource);
    assert.equal(await files.read(fixture.uri.fsPath), fixture.before);
    assert.deepEqual(journal.list(), []);
    console.log(
      'PASS: native notebook edit refuses dirty cells without changing user work, serialized disk or review.',
    );
  } finally {
    await tools.finish();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    fixture.dispose();
  }
}
