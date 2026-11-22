import * as vscode from 'vscode';
import path from 'node:path';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { minimatch } from 'minimatch';
import { checkedReadPath } from './file-policy.js';
import { LexicalIndex } from './search-index.js';
import { ProjectIgnores } from './search-ignore.js';
import { SemanticIndex, semanticBackend } from './semantic-index.js';
import type { EditorRequest } from './editor-policy.js';

interface Scope {
  cwd: string;
  privateRoot?: string;
  signal: AbortSignal;
}
type Search = Extract<EditorRequest, { action: 'search' | 'semanticSearch' }>;
type Resolve = (uri: vscode.Uri) => Promise<vscode.Uri | undefined>;
const lexicalIndex = new LexicalIndex();
const semanticIndex = new SemanticIndex();

function fingerprint(info: vscode.FileStat, version: number, identity?: string) {
  return JSON.stringify([info.type, info.ctime, info.mtime, info.size, version, identity]);
}

function diskIdentity(info: BigIntStats) {
  return JSON.stringify(
    [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map((value) => value.toString()),
  );
}

function utf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function boundedRead(handle: FileHandle, size: number, signal: AbortSignal) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    signal.throwIfAborted();
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function diskSnapshot(uri: vscode.Uri, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const handle = await open(uri.fsPath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) return;
    const bytes = await boundedRead(handle, Math.min(limit + 1, Number(before.size) + 1), signal);
    const after = await handle.stat({ bigint: true });
    signal.throwIfAborted();
    if (bytes.length !== Number(before.size) || diskIdentity(before) !== diskIdentity(after))
      return;
    const text = utf8(bytes);
    if (text === undefined || text.includes('\0')) return;
    return { text, identity: diskIdentity(after) };
  } finally {
    await handle.close();
  }
}

async function documentSnapshot(uri: vscode.Uri, scope: Scope) {
  const info = await vscode.workspace.fs.stat(uri);
  if (info.type !== vscode.FileType.File || info.size > 1_048_576) return;
  const document = await vscode.workspace.openTextDocument(uri);
  scope.signal.throwIfAborted();
  const dirty = document.isDirty;
  const disk = dirty ? undefined : await diskSnapshot(uri, 1_048_576, scope.signal);
  const text = dirty
    ? document.getText(new vscode.Range(new vscode.Position(0, 0), document.positionAt(1_048_577)))
    : disk?.text;
  if (text === undefined || text.includes('\0') || Buffer.byteLength(text) > 1_048_576) return;
  return {
    document,
    text,
    dirty,
    fingerprint: fingerprint(info, document.version, disk?.identity),
  };
}

type Captured = {
  uri: vscode.Uri;
  content: NonNullable<Awaited<ReturnType<typeof documentSnapshot>>>;
};

async function freshSource(
  uri: vscode.Uri,
  content: Captured['content'],
  scope: Scope,
  resolve: Resolve,
) {
  const resolved = await resolve(uri);
  if (!resolved || resolved.toString() !== uri.toString()) return false;
  try {
    const info = await vscode.workspace.fs.stat(uri);
    if (content.document.isDirty !== content.dirty) return false;
    const disk = content.dirty ? undefined : await diskSnapshot(uri, 1_048_576, scope.signal);
    return (
      fingerprint(info, content.document.version, disk?.identity) === content.fingerprint &&
      (content.dirty ? content.document.getText() : disk?.text) === content.text
    );
  } catch {
    scope.signal.throwIfAborted();
    return false;
  }
}

function exclusions(scope: Scope) {
  const root = vscode.Uri.file(scope.cwd);
  const values = ['files', 'search'].flatMap((section) =>
    Object.entries(
      vscode.workspace.getConfiguration(section, root).get<Record<string, unknown>>('exclude', {}),
    ),
  );
  if (values.length > 256) throw new Error('Workspace search exclusions exceed 256 patterns.');
  return {
    patterns: values.filter(([, enabled]) => enabled === true).map(([pattern]) => pattern),
    partial: values.some(([, enabled]) => enabled !== true && enabled !== false),
    signature: JSON.stringify(values),
  };
}

function excluded(relative: string, patterns: readonly string[]) {
  const parts = relative.split('/');
  return patterns.some((pattern) =>
    parts.some((_, index) => minimatch(parts.slice(0, index + 1).join('/'), pattern)),
  );
}

async function readRule(relative: string, scope: Scope, resolve: Resolve) {
  scope.signal.throwIfAborted();
  try {
    const target = await checkedReadPath(relative, scope.cwd, scope.privateRoot);
    const uri = await resolve(vscode.Uri.file(target));
    if (!uri) throw new Error('Project ignore rule is outside eligible workspace text.');
    const overlay = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString() && document.isDirty,
    );
    if (overlay) return overlay.getText();
    const disk = await diskSnapshot(uri, 65536, scope.signal);
    if (!disk) throw new Error('Project ignore rule violates stable regular text limits.');
    return disk.text;
  } catch (error) {
    scope.signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function captureSources(
  candidates: vscode.Uri[],
  scope: Scope,
  resolve: Resolve,
  ignores: ProjectIgnores,
  configured: ReturnType<typeof exclusions>,
) {
  const result = {
    scannedFiles: 0,
    skippedFiles: 0,
    ignoredFiles: 0,
    limited: candidates.length > 256 || configured.partial,
  };
  const captured: Captured[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const candidate of candidates.slice(0, 256)) {
    scope.signal.throwIfAborted();
    const uri = await resolve(candidate);
    if (!uri || paths.has(uri.toString())) continue;
    const relative = path.relative(scope.cwd, uri.fsPath);
    if (excluded(relative, configured.patterns) || !(await ignores.accepts(relative))) {
      result.ignoredFiles++;
      continue;
    }
    const content = await documentSnapshot(uri, scope);
    if (!content) {
      result.skippedFiles++;
      result.limited = true;
      continue;
    }
    bytes += Buffer.byteLength(content.text);
    if (bytes > 4_194_304) {
      result.limited = true;
      break;
    }
    result.scannedFiles++;
    paths.add(uri.toString());
    captured.push({ uri, content });
  }
  return { result, captured };
}

async function workspaceSources(
  input: Search,
  scope: Scope,
  token: vscode.CancellationToken,
  resolve: Resolve,
) {
  const candidates = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(scope.cwd), input.glob),
    '{**/.git/**,**/node_modules/**,**/.local-dev/**,**/dist/**,**/reports/**}',
    257,
    token,
  );
  const configured = exclusions(scope);
  const ignores = new ProjectIgnores(
    (relative) => readRule(relative, scope, resolve),
    scope.signal,
  );
  const { result, captured } = await captureSources(
    candidates,
    scope,
    resolve,
    ignores,
    configured,
  );
  return { result, captured, ignores, configured };
}

async function freshWorkspace(
  capture: Awaited<ReturnType<typeof workspaceSources>>,
  scope: Scope,
  resolve: Resolve,
) {
  for (const { uri, content } of capture.captured)
    if (!(await freshSource(uri, content, scope, resolve))) return false;
  return (
    (await capture.ignores.fresh()) && exclusions(scope).signature === capture.configured.signature
  );
}

function indexedSources(captured: Captured[], cwd: string) {
  return captured.map(({ uri, content }) => ({
    path: path.relative(cwd, uri.fsPath),
    text: content.text,
    fingerprint: content.fingerprint,
  }));
}

export async function searchWorkspace(
  input: Extract<Search, { action: 'search' }>,
  scope: Scope,
  token: vscode.CancellationToken,
  resolve: Resolve,
) {
  const capture = await workspaceSources(input, scope, token, resolve);
  const { result, captured, ignores } = capture;
  if (!(await freshWorkspace(capture, scope, resolve)))
    return { ...result, items: [], limited: true, stale: true, index: 'lexical' };
  scope.signal.throwIfAborted();
  lexicalIndex.update(
    JSON.stringify([scope.cwd, scope.privateRoot]),
    indexedSources(captured, scope.cwd),
    scope.signal,
  );
  const indexed = lexicalIndex.search(input.query, input.caseSensitive, input.limit);
  return {
    ...result,
    ...indexed,
    limited: result.limited || indexed.limited,
    stale: false,
    overlayFiles: captured.filter(({ content }) => content.document.isDirty).length,
    inspectedIgnoreFiles: ignores.inspectedFiles,
    coverage: result.limited ? 'partial' : 'bounded-candidates',
  };
}

export async function semanticSearchWorkspace(
  input: Extract<Search, { action: 'semanticSearch' }>,
  scope: Scope,
  token: vscode.CancellationToken,
  resolve: Resolve,
) {
  const summary = {
    index: 'semantic',
    backend: input.backend,
    items: [],
    limited: true,
    unavailable: true,
  };
  if (input.backend !== semanticBackend) return { ...summary, reason: 'backend-unavailable' };
  const capture = await workspaceSources(input, scope, token, resolve);
  let prepared;
  try {
    prepared = await semanticIndex.prepare(
      JSON.stringify([scope.cwd, scope.privateRoot]),
      indexedSources(capture.captured, scope.cwd),
      scope.signal,
    );
  } catch {
    scope.signal.throwIfAborted();
    return { ...summary, reason: 'backend-error' };
  }
  if (!(await freshWorkspace(capture, scope, resolve)))
    return { ...capture.result, ...summary, unavailable: false, stale: true };
  scope.signal.throwIfAborted();
  const result = prepared.search(input.query, input.limit);
  const limited = capture.result.limited || result.limited;
  return {
    ...capture.result,
    ...result,
    limited,
    unavailable: false,
    stale: false,
    overlayFiles: capture.captured.filter(({ content }) => content.dirty).length,
    inspectedIgnoreFiles: capture.ignores.inspectedFiles,
    coverage: limited ? 'partial' : 'bounded-candidates',
  };
}
