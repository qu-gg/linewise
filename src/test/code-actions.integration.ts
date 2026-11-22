import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codeActionRequest } from '../code-action-policy.js';
import { codeActionsWorkspace } from '../host-code-actions.js';
import { WorkspaceFiles } from '../workspace.js';
import { ReviewJournal, PathGuard } from '../review.js';

export async function codeActionFixtures(root: vscode.Uri) {
  const source = vscode.Uri.joinPath(root, 'action-source.ts');
  const dependency = vscode.Uri.joinPath(root, 'action-dependency.ts');
  const before =
    'import { unused, used } from "./action-dependency";\nexport const result = used;\n';
  const provider = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(provider);
  await provider.activate();
  await vscode.workspace.fs.writeFile(source, Buffer.from(before));
  await vscode.workspace.fs.writeFile(
    dependency,
    Buffer.from('export const used = 7;\nexport const unused = 9;\n'),
  );
  await vscode.window.showTextDocument(source);
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', source);
  return { source, dependency, before };
}

export async function refactorFixtures(root: vscode.Uri) {
  const source = vscode.Uri.joinPath(root, 'source.ts');
  const usage = vscode.Uri.joinPath(root, 'usage.ts');
  const before =
    'export function pricedAmount(price: number) {\n  const amount = price * 2;\n  return amount + 1;\n}\nexport const unchanged = 11;\n';
  const references =
    'import { pricedAmount } from "./source";\nexport const value = pricedAmount(3);\nexport function localShadow(amount: number) { return amount; }\n';
  await vscode.workspace.fs.writeFile(source, Buffer.from(before));
  await vscode.workspace.fs.writeFile(usage, Buffer.from(references));
  await vscode.window.showTextDocument(usage);
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', usage);
  await vscode.window.showTextDocument(source);
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', source);
  return { source, usage, before, references };
}

export async function nativeReviewedCodeAction(root: vscode.Uri): Promise<void> {
  const { source, dependency, before } = await codeActionFixtures(root);
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
  const input = codeActionRequest.parse({
    action: 'list',
    path: source.fsPath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
    kind: 'source.organizeImports',
    title: null,
    paths: [source.fsPath],
  });
  const scope = actionScope(root);
  const write = (image: Parameters<Parameters<typeof codeActionsWorkspace>[2]>[0]) =>
    journal.write('native-action', image.path, image.content, scope.signal, image.before, {
      tool: 'code_action',
    });
  try {
    const listed = JSON.parse(await codeActionsWorkspace(input, scope, write));
    const selected = listed.actions.find((action: { available: boolean }) => action.available);
    assert.ok(selected, JSON.stringify(listed));
    assert.equal(selected.commandIgnored, true);
    assert.equal(await files.read(source.fsPath), before);
    assert.equal(journal.list().length, 0);
    const result = JSON.parse(
      await codeActionsWorkspace(
        codeActionRequest.parse({ ...input, action: 'apply', title: selected.title }),
        scope,
        write,
      ),
    );
    assert.equal(result.completed, 1);
    assert.doesNotMatch((await files.read(source.fsPath))!, /unused/);
    assert.match((await files.read(source.fsPath))!, /used/);
    const clean = JSON.parse(await codeActionsWorkspace(input, scope, write));
    assert.ok(
      clean.actions.every((action: { available: boolean }) => !action.available),
      JSON.stringify(clean),
    );
    const reopened = new ReviewJournal(
      files,
      new PathGuard([root.fsPath]),
      async () => false,
      async () => {},
      JSON.parse(persisted),
    );
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0]!.operations![0]!.tool, 'code_action');
    await reopened.discard(reopened.list()[0]!.id);
    assert.equal(await files.read(source.fsPath), before);
    console.log(
      'PASS: native TypeScript code action lists without mutation, organizes imports through durable review and Discard restores the exact source.',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(source, { recursive: false, useTrash: false });
    await vscode.workspace.fs.delete(dependency, { recursive: false, useTrash: false });
  }
}

async function refactorReview(root: vscode.Uri) {
  const fixture = await refactorFixtures(root);
  const files = new WorkspaceFiles(root);
  const scope = actionScope(root);
  let persisted = '[]';
  const load = () =>
    new ReviewJournal(
      files,
      new PathGuard([root.fsPath]),
      async () => false,
      async (changes) => {
        persisted = JSON.stringify(changes);
      },
      JSON.parse(persisted),
    );
  const input = codeActionRequest.parse({
    action: 'list',
    path: fixture.source.fsPath,
    line: 1,
    column: 17,
    endLine: 1,
    endColumn: 29,
    kind: 'refactor.rewrite.export.default',
    title: null,
    paths: [fixture.source.fsPath, fixture.usage.fsPath],
  });
  return { ...fixture, files, scope, load, input };
}

async function verifyRefactorImages(current: Awaited<ReturnType<typeof refactorReview>>) {
  const source = (await current.files.read(current.source.fsPath))!;
  const usage = (await current.files.read(current.usage.fsPath))!;
  assert.ok(source.includes('export default function pricedAmount'));
  assert.ok(source.includes('export const unchanged = 11;'));
  assert.ok(usage.includes('import pricedAmount from "./source";'));
  assert.ok(usage.includes('pricedAmount(3)'));
  assert.ok(usage.includes(current.references.split('\n')[2]!));
  return { source, usage };
}

export async function nativeReviewedRefactor(root: vscode.Uri) {
  const current = await refactorReview(root);
  let journal = current.load();
  const write = (image: Parameters<Parameters<typeof codeActionsWorkspace>[2]>[0]) =>
    journal.write(
      'native-refactor',
      image.path,
      image.content,
      current.scope.signal,
      image.before,
      { tool: 'code_action' },
    );
  for (const decision of ['discard', 'keep'] as const) {
    const listed = JSON.parse(await codeActionsWorkspace(current.input, current.scope, write));
    const selected = listed.actions.filter((action: { available: boolean }) => action.available);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].kind, 'refactor.rewrite.export.default');
    assert.equal(selected[0].commandIgnored, true);
    const result = JSON.parse(
      await codeActionsWorkspace(
        codeActionRequest.parse({ ...current.input, action: 'apply', title: selected[0].title }),
        current.scope,
        write,
      ),
    );
    assert.equal(result.completed, 2);
    assert.deepEqual([...result.files].sort(), ['source.ts', 'usage.ts']);
    const after = await verifyRefactorImages(current);
    journal = current.load();
    assert.equal(journal.list().length, 2);
    for (const change of journal.list()) {
      assert.equal(change.operations![0]!.tool, 'code_action');
      await journal[decision](change.id);
    }
    assert.equal(current.load().list().length, 0);
    assert.equal(
      await current.files.read(current.source.fsPath),
      decision === 'discard' ? current.before : after.source,
    );
    assert.equal(
      await current.files.read(current.usage.fsPath),
      decision === 'discard' ? current.references : after.usage,
    );
  }
  const stopped = await interruptedRefactor(root);
  return {
    kind: current.input.kind,
    completedFiles: 2,
    journalReopened: true,
    discardedAndReread: true,
    keptAndReread: true,
    shadowPreserved: true,
    stopped,
  };
}

async function interruptedRefactor(root: vscode.Uri) {
  const current = await refactorReview(root);
  const abort = new AbortController();
  const scope = { ...current.scope, signal: abort.signal };
  const journal = current.load();
  const write = async (image: Parameters<Parameters<typeof codeActionsWorkspace>[2]>[0]) => {
    await journal.write(
      'native-refactor-stop',
      image.path,
      image.content,
      scope.signal,
      image.before,
      { tool: 'code_action' },
    );
    abort.abort(new Error('Stopped after first durable refactor write'));
  };
  const listed = JSON.parse(await codeActionsWorkspace(current.input, scope, write));
  const selected = listed.actions.find((action: { available: boolean }) => action.available);
  assert.ok(selected);
  await assert.rejects(
    codeActionsWorkspace(
      codeActionRequest.parse({ ...current.input, action: 'apply', title: selected.title }),
      scope,
      write,
    ),
    /Stopped.*\(1 code action files completed/,
  );
  const reopened = current.load();
  assert.equal(reopened.list().length, 1);
  await reopened.discard(reopened.list()[0]!.id);
  assert.equal(await current.files.read(current.source.fsPath), current.before);
  assert.equal(await current.files.read(current.usage.fsPath), current.references);
  return { completed: 1, pendingReview: 1, discardedAndReread: true };
}

function actionScope(root: vscode.Uri) {
  return {
    cwd: root.fsPath,
    privateRoot: path.join(root.fsPath, '.action-private'),
    signal: AbortSignal.timeout(20000),
    valid: () => true,
  };
}
