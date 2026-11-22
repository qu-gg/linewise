import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { editorRequest } from '../editor-policy.js';
import type { PendingApproval } from '../approvals.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (text: string, approve: (approval: PendingApproval) => boolean) => Promise<string>;

export async function workspaceSymbolFixtures(root: string) {
  const name = `parityQuote_${randomUUID().replaceAll('-', '')}`;
  const factor = randomInt(10, 50);
  const nextFactor = factor + 50;
  const source = vscode.Uri.file(path.join(root, 'src/workspace-symbol-owner.ts'));
  const usage = vscode.Uri.file(path.join(root, 'src/workspace-symbol-usage.ts'));
  await mkdir(path.dirname(source.fsPath), { recursive: true });
  await writeFile(
    source.fsPath,
    `export function ${name}(units: number) { return units * ${factor}; }\n`,
  );
  await writeFile(
    usage.fsPath,
    `import { ${name} } from "./workspace-symbol-owner";\nexport const sample = ${name}(3);\n`,
  );
  const provider = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(provider);
  await provider.activate();
  const document = await vscode.workspace.openTextDocument(source);
  await vscode.workspace.openTextDocument(usage);
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', usage);
  return {
    name,
    factor,
    nextFactor,
    source,
    usage,
    async change() {
      const replacement = document.getText().replace(`* ${factor};`, `* ${nextFactor};`);
      assert.notEqual(replacement, document.getText());
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        source,
        new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
        replacement,
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(await document.save(), true);
      await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', source);
    },
  };
}

export async function workspaceSymbolWorkflow(
  api: Api,
  root: string,
  prompt: Prompt,
): Promise<void> {
  const fixture = await workspaceSymbolFixtures(root);
  const first = await prompt(
    `Use only editor and read. Query editor workspaceSymbols with query ${JSON.stringify(fixture.name)} to discover its definition without assuming a file path. Read its implementation and use editor references on the identifier to find the caller; the provider range may cover the whole declaration, so locate the identifier's actual column from the source first. Report the exact multiplier in the function and the caller path. Do not edit or use shell/search/files or retry failed actions.`,
    () => false,
  );
  assert.match(first, new RegExp(`\\b${fixture.factor}\\b`));
  assert.ok(first.includes('workspace-symbol-usage.ts'));
  await fixture.change();
  const second = await prompt(
    `The disposable fixture owner changed the implementation. Use only editor workspaceSymbols for query ${JSON.stringify(fixture.name)} and read its current source. Report the current multiplier from fresh tool data, not the previous answer. Do not edit or use other tools.`,
    () => false,
  );
  assert.match(second, new RegExp(`\\b${fixture.nextFactor}\\b`));
  const absent = `notPresent_${randomUUID().replaceAll('-', '')}`;
  const third = await prompt(
    `Use only editor workspaceSymbols once for query ${JSON.stringify(absent)}. Report the provider result honestly and whether that alone proves semantic/codebase-wide absence. Do not fall back or call other tools.`,
    () => false,
  );
  assert.match(third, /not|cannot|doesn.t|no.*prove|isn.t/i);
  const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  assert.ok(report.tools.every((tool: { name: string }) => ['editor', 'read'].includes(tool.name)));
  assert.ok(report.tools.filter((tool: { name: string }) => tool.name === 'read').length >= 2);
  assert.ok(report.results.every((result: { isError: boolean }) => !result.isError));
  assert.ok(
    report.results.some(
      (result: { name: string; content: string }) =>
        result.name === 'read' && result.content.includes(`* ${fixture.factor};`),
    ),
  );
  assert.ok(
    report.results.some(
      (result: { name: string; content: string }) =>
        result.name === 'read' && result.content.includes(`* ${fixture.nextFactor};`),
    ),
  );
  const editor = report.tools
    .filter((tool: { name: string }) => tool.name === 'editor')
    .map((tool: { input: string }) => editorRequest.parse(JSON.parse(tool.input)));
  assert.deepEqual(
    editor.map((input: { action: string }) => input.action),
    ['workspaceSymbols', 'references', 'workspaceSymbols', 'workspaceSymbols'],
  );
  assert.equal(api.status()!.changes.length, 0);
  console.log(
    'PASS: three-turn genuine-model workspace symbol discovery/references, changed-source fresh reread and honest empty-provider result.',
  );
}
