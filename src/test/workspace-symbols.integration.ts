import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { inspectEditor } from '../host-inspect.js';
import { editorRequest } from '../editor-policy.js';
import { workspaceSymbolFixtures } from './live-workspace-symbols.js';

export async function nativeWorkspaceSymbols(root: vscode.Uri): Promise<void> {
  const fixture = await workspaceSymbolFixtures(root.fsPath);
  const scope = {
    cwd: root.fsPath,
    privateRoot: vscode.Uri.joinPath(root, '.symbol-private').fsPath,
    signal: AbortSignal.timeout(20000),
  };
  const symbols = async () =>
    JSON.parse(
      await inspectEditor(
        editorRequest.parse({ action: 'workspaceSymbols', query: fixture.name }),
        scope,
      ),
    );
  const first = await symbols();
  const definition = first.items.find(
    (item: { name: string; path: string }) =>
      item.name.replace(/\(\)$/, '') === fixture.name &&
      item.path === 'src/workspace-symbol-owner.ts',
  );
  assert.ok(definition, JSON.stringify(first));
  assert.equal(first.providerDependent, true);
  assert.equal(first.untrusted, true);
  const document = await vscode.workspace.openTextDocument(fixture.source);
  const identifier = document.positionAt(document.getText().indexOf(fixture.name));
  const references = JSON.parse(
    await inspectEditor(
      editorRequest.parse({
        action: 'references',
        path: definition.path,
        line: identifier.line + 1,
        column: identifier.character + 1,
      }),
      scope,
    ),
  );
  assert.ok(
    references.items.some(
      (item: { path: string }) => item.path === 'src/workspace-symbol-usage.ts',
    ),
  );
  await fixture.change();
  assert.ok(
    (await symbols()).items.some(
      (item: { name: string }) => item.name.replace(/\(\)$/, '') === fixture.name,
    ),
  );
  assert.ok(document.getText().includes(`* ${fixture.nextFactor};`));
  const empty = JSON.parse(
    await inspectEditor(
      editorRequest.parse({ action: 'workspaceSymbols', query: `${fixture.name}_notPresent` }),
      scope,
    ),
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.providerDependent, true);
  console.log(
    'PASS: native TypeScript workspace symbols discover cross-file definition/references, retain fresh source and report provider-dependent empty results.',
  );
}
