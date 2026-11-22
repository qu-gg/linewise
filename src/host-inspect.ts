import * as vscode from 'vscode';
import path from 'node:path';
import { checkedReadPath } from './file-policy.js';
import { PathGuard } from './path-guard.js';
import type { EditorRequest } from './editor-policy.js';
import { searchWorkspace, semanticSearchWorkspace } from './host-search.js';
import { workspaceTaskMetadata } from './host-tasks.js';

interface Scope {
  cwd: string;
  privateRoot?: string;
  signal: AbortSignal;
}

async function workspaceUri(target: string, scope: Scope): Promise<vscode.Uri> {
  const resolved = await checkedReadPath(target, scope.cwd, scope.privateRoot);
  if (!(await new PathGuard([scope.cwd]).resolve(resolved)).inside)
    throw new Error(
      'Editor inspection is workspace-only; use read with approval for outside files.',
    );
  scope.signal.throwIfAborted();
  return vscode.Uri.file(resolved);
}

async function resultUri(uri: vscode.Uri, scope: Scope): Promise<vscode.Uri | undefined> {
  if (uri.scheme !== 'file') return;
  try {
    return await workspaceUri(uri.fsPath, scope);
  } catch {
    scope.signal.throwIfAborted();
  }
}

function location(uri: vscode.Uri, range: vscode.Range, cwd: string) {
  return {
    path: path.relative(cwd, uri.fsPath),
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

interface InspectionSummary {
  limited: boolean;
  scannedFiles?: number;
  skippedFiles?: number;
  inspectedSymbols?: number;
  providerDependent?: boolean;
  untrusted?: boolean;
}

function bounded(items: object[], limit: number, summary?: InspectionSummary): string {
  const selected: object[] = [];
  for (const item of items.slice(0, limit)) {
    if (Buffer.byteLength(JSON.stringify([...selected, item])) > 63_000) break;
    selected.push(item);
  }
  return JSON.stringify({
    ...summary,
    items: selected,
    limited: Boolean(summary?.limited || items.length > selected.length),
  });
}

async function searchableUri(candidate: vscode.Uri, scope: Scope) {
  const uri = await resultUri(candidate, scope);
  const excluded = ['.git', 'node_modules', '.local-dev', 'dist', 'reports'];
  if (
    uri &&
    !path
      .relative(scope.cwd, uri.fsPath)
      .split(path.sep)
      .some((part) => excluded.includes(part))
  )
    return uri;
}

async function diagnostics(
  input: Extract<EditorRequest, { action: 'diagnostics' }>,
  scope: Scope,
): Promise<object[]> {
  const target = 'path' in input && input.path ? await workspaceUri(input.path, scope) : undefined;
  const results: object[] = [];
  for (const [candidate, entries] of vscode.languages.getDiagnostics().slice(0, 1000)) {
    if (target && candidate.toString() !== target.toString()) continue;
    const uri = await resultUri(candidate, scope);
    if (!uri) continue;
    for (const entry of entries.slice(0, input.limit + 1))
      results.push({
        ...location(uri, entry.range, scope.cwd),
        severity: entry.severity,
        message: entry.message.slice(0, 2000),
      });
    if (results.length > input.limit) break;
  }
  return results;
}

async function symbols(
  uri: vscode.Uri,
  input: Extract<EditorRequest, { action: 'symbols' }>,
  scope: Scope,
): Promise<object[]> {
  const pending =
    (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    )) ?? [];
  const results: object[] = [];
  for (let index = 0; index < pending.length && results.length <= input.limit; index++) {
    const item = pending[index]!;
    const target = 'location' in item ? await resultUri(item.location.uri, scope) : uri;
    if (target)
      results.push({
        ...location(target, 'location' in item ? item.location.range : item.range, scope.cwd),
        name: item.name.slice(0, 512),
        kind: item.kind,
      });
    if ('children' in item) pending.push(...item.children.slice(0, input.limit + 1));
  }
  return results;
}

async function workspaceSymbols(
  input: Extract<EditorRequest, { action: 'workspaceSymbols' }>,
  scope: Scope,
): Promise<InspectionSummary & { items: object[] }> {
  const entries =
    (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      input.query,
    )) ?? [];
  if (!Array.isArray(entries))
    throw new Error('Workspace symbol provider returned an unsupported result.');
  const items: object[] = [];
  let inspectedSymbols = 0;
  for (const entry of entries.slice(0, 1000)) {
    scope.signal.throwIfAborted();
    inspectedSymbols++;
    const uri = await searchableUri(entry.location.uri, scope);
    if (!uri) continue;
    items.push({
      ...location(uri, entry.location.range, scope.cwd),
      name: entry.name.slice(0, 512),
      kind: entry.kind,
      container: entry.containerName?.slice(0, 512),
    });
    if (items.length > input.limit) break;
  }
  return {
    items,
    inspectedSymbols,
    limited: inspectedSymbols < entries.length,
    providerDependent: true,
    untrusted: true,
  };
}

async function fileMatches(
  input: Extract<EditorRequest, { action: 'files' }>,
  scope: Scope,
  token: vscode.CancellationToken,
): Promise<object[]> {
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(scope.cwd), input.glob),
    null,
    input.limit + 1,
    token,
  );
  const results: object[] = [];
  for (const match of matches) {
    const uri = await resultUri(match, scope);
    if (uri) results.push({ path: path.relative(scope.cwd, uri.fsPath) });
  }
  return results;
}

async function inspect(
  input: Exclude<EditorRequest, { action: 'search' | 'semanticSearch' | 'notebookImage' }>,
  scope: Scope,
  token: vscode.CancellationToken,
): Promise<object[] | (InspectionSummary & { items: object[] })> {
  if (input.action === 'diagnostics') return diagnostics(input, scope);
  if (input.action === 'files') return fileMatches(input, scope, token);
  if (input.action === 'tasks') return workspaceTasks(input.limit, scope);
  if (input.action === 'workspaceSymbols') return workspaceSymbols(input, scope);
  const uri = await workspaceUri(input.path, scope);
  if (input.action === 'notebook') return notebookCells(uri, input);
  if (input.action === 'symbols') return symbols(uri, input, scope);
  return navigation(uri, input, scope);
}

async function navigation(
  uri: vscode.Uri,
  input: Extract<EditorRequest, { line: number }>,
  scope: Scope,
): Promise<object[]> {
  const command =
    input.action === 'definitions'
      ? 'vscode.executeDefinitionProvider'
      : 'vscode.executeReferenceProvider';
  const entries =
    (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      command,
      uri,
      new vscode.Position(input.line - 1, input.column - 1),
    )) ?? [];
  const results: object[] = [];
  for (const entry of entries.slice(0, input.limit + 1)) {
    const target =
      'uri' in entry
        ? entry
        : {
            uri: entry.targetUri,
            range: entry.targetSelectionRange ?? entry.targetRange,
          };
    const resolved = await resultUri(target.uri, scope);
    if (resolved) results.push(location(resolved, target.range, scope.cwd));
  }
  return results;
}

async function workspaceTasks(limit: number, scope: Scope): Promise<object[]> {
  return workspaceTaskMetadata(scope, limit);
}

function cellOutputs(cell: vscode.NotebookCell): object[] {
  const outputs: object[] = [];
  let remaining = 8000;
  for (const [outputIndex, output] of cell.outputs.slice(0, 8).entries()) {
    for (const [itemIndex, item] of output.items.slice(0, 8).entries()) {
      const textual =
        /^(text\/|application\/(json|vnd\.code\.notebook\.(stdout|stderr)|vnd\.code\.notebook\.error))/.test(
          item.mime,
        );
      const length = textual ? Math.min(remaining, 2000, item.data.byteLength) : 0;
      remaining -= length;
      outputs.push({
        output: outputIndex + 1,
        item: itemIndex + 1,
        mime: item.mime.slice(0, 200),
        bytes: item.data.byteLength,
        text: length ? new TextDecoder().decode(item.data.subarray(0, length)) : undefined,
        limited: item.data.byteLength > length || !textual,
      });
    }
  }
  return outputs;
}

async function notebookImage(
  input: Extract<EditorRequest, { action: 'notebookImage' }>,
  scope: Scope,
): Promise<string> {
  const uri = await workspaceUri(input.path, scope);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  scope.signal.throwIfAborted();
  if (input.cell > notebook.cellCount) throw new Error('Notebook image cell is unavailable.');
  const item = notebook.cellAt(input.cell - 1).outputs[input.output - 1]?.items[input.item - 1];
  if (!item) throw new Error('Notebook image output item is unavailable.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(item.mime))
    throw new Error('Notebook image supports PNG, JPEG or WebP only; no HTML/SVG rendering.');
  if (!item.data.byteLength || item.data.byteLength > 524288)
    throw new Error('Notebook image must contain at most 512 KiB.');
  const data = Buffer.from(item.data);
  const signatures: Record<string, boolean> = {
    'image/png': data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': data.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    'image/webp':
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!signatures[item.mime]) throw new Error('Notebook image signature does not match its MIME.');
  return JSON.stringify({ data: data.toString('base64'), mimeType: item.mime, untrusted: true });
}

async function notebookCells(
  uri: vscode.Uri,
  input: Extract<EditorRequest, { action: 'notebook' }>,
): Promise<object[]> {
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  if (input.startCell > notebook.cellCount) return [];
  const cells = notebook.getCells(
    new vscode.NotebookRange(
      input.startCell - 1,
      Math.min(notebook.cellCount, input.startCell + input.limit),
    ),
  );
  return cells.map((cell) => ({
    cell: cell.index + 1,
    cellCount: notebook.cellCount,
    notebookType: notebook.notebookType.slice(0, 200),
    dirty: notebook.isDirty,
    kind: cell.kind,
    language: cell.document.languageId,
    text: cell.document.getText(
      new vscode.Range(new vscode.Position(0, 0), cell.document.positionAt(8000)),
    ),
    outputs: cellOutputs(cell),
    partial:
      cell.document.getText().length > 8000 ||
      cell.outputs.length > 8 ||
      cell.outputs.some((output) => output.items.length > 8),
  }));
}

export async function inspectEditor(input: EditorRequest, scope: Scope): Promise<string> {
  scope.signal.throwIfAborted();
  const source = new vscode.CancellationTokenSource();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      source.cancel();
      reject(scope.signal.reason);
    };
    scope.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (input.action === 'notebookImage') {
      const image = await Promise.race([notebookImage(input, scope), aborted]);
      scope.signal.throwIfAborted();
      return image;
    }
    const operation =
      input.action === 'search'
        ? searchWorkspace(input, scope, source.token, (uri) => searchableUri(uri, scope))
        : input.action === 'semanticSearch'
          ? semanticSearchWorkspace(input, scope, source.token, (uri) => searchableUri(uri, scope))
          : inspect(input, scope, source.token);
    const results = await Promise.race([operation, aborted]);
    scope.signal.throwIfAborted();
    if (!Array.isArray(results)) return bounded(results.items, input.limit, results);
    return bounded(results, input.limit);
  } finally {
    scope.signal.removeEventListener('abort', cancel);
    source.dispose();
  }
}
