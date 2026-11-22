import * as vscode from 'vscode';
import path from 'node:path';
import { checkedPath } from './file-policy.js';
import { PathGuard } from './path-guard.js';
import type { RenameRequest } from './rename-policy.js';

type Operation = 'rename' | 'code action' | 'notebook edit';
interface Scope {
  cwd: string;
  privateRoot?: string;
  signal: AbortSignal;
  valid(): boolean;
  operation?: Operation;
}
interface Capture {
  path: string;
  document: vscode.TextDocument;
  before: string;
  version: number;
}
export interface RenameImage {
  path: string;
  before: string;
  content: string;
}

function current(scope: Scope): void {
  scope.signal.throwIfAborted();
  if (!scope.valid()) throw new Error('Rename belongs to a retired prompt.');
}

async function targetPath(target: string, scope: Scope): Promise<string> {
  const resolved = await checkedPath(
    target,
    scope.cwd,
    scope.privateRoot,
    scope.operation !== 'notebook edit',
  );
  if (
    path.resolve(scope.cwd, target) !== resolved ||
    !(await new PathGuard([scope.cwd]).resolve(resolved)).inside
  )
    throw new Error('Rename targets must be canonical workspace text files.');
  current(scope);
  return resolved;
}

async function captureFiles(
  input: Pick<RenameRequest, 'paths'>,
  scope: Scope,
): Promise<Map<string, Capture>> {
  const files = new Map<string, Capture>();
  let bytes = 0;
  for (const candidate of input.paths) {
    const target = await targetPath(candidate, scope);
    if (files.has(target)) throw new Error('Rename paths must be unique.');
    const uri = vscode.Uri.file(target);
    if (vscode.workspace.getConfiguration('files', uri).get('encoding', 'utf8') !== 'utf8')
      throw new Error('Rename supports UTF-8 files only.');
    const metadata = await vscode.workspace.fs.stat(uri);
    if (metadata.type !== vscode.FileType.File || metadata.size > 1_048_576)
      throw new Error('Rename requires regular text files up to 1 MiB.');
    const document = await vscode.workspace.openTextDocument(uri);
    const before = document.getText();
    const size = Buffer.byteLength(before);
    if (size > 1_048_576) throw new Error('Rename requires regular text files up to 1 MiB.');
    bytes += size;
    if (document.isDirty || before.includes('\0') || bytes > 4_194_304)
      throw captureLimit(scope.operation);
    files.set(target, { path: target, document, before, version: document.version });
    current(scope);
  }
  return files;
}

function captureLimit(operation: Operation = 'rename'): Error {
  return new Error(`Save ${operation} targets first; captures are limited to 4 MiB of text.`);
}

function offset(document: vscode.TextDocument, position: vscode.Position): number {
  if (
    !Number.isInteger(position?.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new Error('Rename provider returned an invalid position.');
  const result = document.offsetAt(position);
  if (!document.positionAt(result).isEqual(position))
    throw new Error('Rename provider returned an out-of-range position.');
  return result;
}

export function documentPosition(
  document: vscode.TextDocument,
  line: number,
  column: number,
): vscode.Position {
  const position = new vscode.Position(line - 1, column - 1);
  offset(document, position);
  return position;
}

function postimage(capture: Capture, edits: readonly vscode.TextEdit[]): string {
  let bytes = 0;
  const ranges = edits.map((edit) => {
    if (typeof edit.newText !== 'string' || Buffer.byteLength(edit.newText) > 1_048_576)
      throw new Error('Rename supports bounded plain text edits only.');
    bytes += Buffer.byteLength(edit.newText);
    if (bytes > 1_048_576) throw new Error('Rename replacement text exceeds 1 MiB.');
    const start = offset(capture.document, edit.range.start);
    const end = offset(capture.document, edit.range.end);
    if (end < start) throw new Error('Rename provider returned a reversed range.');
    return { start, end, text: edit.newText };
  });
  ranges.sort((left, right) => right.start - left.start || right.end - left.end);
  let previous = capture.before.length + 1;
  let content = capture.before;
  for (const range of ranges) {
    if (range.end > previous || range.start === previous)
      throw new Error('Rename provider returned overlapping edits.');
    content = content.slice(0, range.start) + range.text + content.slice(range.end);
    previous = range.start;
  }
  if (Buffer.byteLength(content) > 1_048_576 || content.includes('\0') || content.includes('#!'))
    throw new Error('Rename postimage exceeds the supported text policy.');
  return content;
}

async function fresh(files: Map<string, Capture>, scope: Scope): Promise<void> {
  for (const capture of files.values()) {
    if ((await targetPath(capture.path, scope)) !== capture.path)
      throw new Error('Rename target changed after capture.');
    const disk = await vscode.workspace.fs.readFile(vscode.Uri.file(capture.path));
    if (disk[0] === 0xef && disk[1] === 0xbb && disk[2] === 0xbf)
      throw new Error('Rename does not support UTF-8 BOM files.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(disk);
    if (
      capture.document.isDirty ||
      capture.document.version !== capture.version ||
      capture.document.getText() !== capture.before ||
      text !== capture.before
    )
      throw new Error('Rename preimage is stale; save and retry from a fresh read.');
  }
  current(scope);
}

async function capturedProvider<Result>(
  input: Pick<RenameRequest, 'path' | 'paths'>,
  scope: Scope,
  provide: (document: vscode.TextDocument) => PromiseLike<Result>,
) {
  current(scope);
  const files = await captureFiles(input, scope);
  const source = files.get(await targetPath(input.path, scope));
  if (!source) throw new Error('Include the source path in rename paths.');
  await fresh(files, scope);
  const result = await provide(source.document);
  current(scope);
  await fresh(files, scope);
  return { result, files };
}

async function prepare(
  input: Pick<RenameRequest, 'path' | 'paths'>,
  scope: Scope,
  provide: (document: vscode.TextDocument) => PromiseLike<vscode.WorkspaceEdit | undefined>,
): Promise<RenameImage[]> {
  const { result, files } = await capturedProvider(input, scope, provide);
  if (!result || !result.size)
    throw new Error('No language provider edits: provider unavailable or refused.');
  const images = await textImages(result, files, scope);
  await fresh(files, scope);
  return images;
}

async function textImages(
  result: vscode.WorkspaceEdit,
  files: Map<string, Capture>,
  scope: Scope,
): Promise<RenameImage[]> {
  const entries = result.entries();
  if (entries.length > 8 || entries.reduce((sum, [, edits]) => sum + edits.length, 0) > 1000)
    throw new Error('Rename exceeds eight text files or 1000 edits.');
  const images: RenameImage[] = [];
  const seen = new Set<string>();
  for (const [uri, edits] of entries) {
    if (uri.scheme !== 'file' || uri.authority)
      throw new Error('Rename provider returned a nonlocal resource.');
    const target = await targetPath(uri.fsPath, scope);
    const capture = files.get(target);
    if (!capture || seen.has(target)) throw new Error('Rename returned an uncaptured target.');
    seen.add(target);
    const content = postimage(capture, edits);
    if (content !== capture.before) images.push({ path: target, before: capture.before, content });
  }
  if (!images.length) throw new Error('Rename produced no supported text changes.');
  return images;
}

export async function renameWorkspace(
  input: RenameRequest,
  scope: Scope,
  write: (image: RenameImage) => Promise<void>,
): Promise<string> {
  return reviewProviderEdits(
    input,
    scope,
    write,
    (document) => {
      return vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
        'vscode.executeDocumentRenameProvider',
        document.uri,
        documentPosition(document, input.line, input.column),
        input.newName,
      );
    },
    'rename',
  );
}

async function providerResult<Result>(pending: Promise<Result>, scope: Scope): Promise<Result> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(scope.signal.reason);
    if (scope.signal.aborted) reject(scope.signal.reason);
    else scope.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    scope.signal.removeEventListener('abort', cancel);
  }
}

export async function inspectProviderResult<Result>(
  input: Pick<RenameRequest, 'path' | 'paths'>,
  scope: Scope,
  provide: (document: vscode.TextDocument) => PromiseLike<Result>,
): Promise<Result> {
  const context = { ...scope, operation: 'code action' as const };
  const captured = await providerResult(capturedProvider(input, context, provide), context);
  return captured.result;
}

export async function reviewProviderEdits(
  input: Pick<RenameRequest, 'path' | 'paths'>,
  scope: Scope,
  write: (image: RenameImage) => Promise<void>,
  provide: (document: vscode.TextDocument) => PromiseLike<vscode.WorkspaceEdit | undefined>,
  operation: Operation,
): Promise<string> {
  const context = { ...scope, operation };
  const pending = prepare(input, context, provide);
  let completed = 0;
  try {
    const images = await providerResult(pending, context);
    for (const image of images) {
      current(scope);
      await write(image);
      completed++;
    }
    return JSON.stringify({
      files: images.map((image) => path.relative(scope.cwd, image.path)),
      completed,
      review: 'pending',
      textOnly: true,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : 'Language provider refused.'} (${completed} ${operation} files completed; applied or interrupted changes remain in review.)`,
      { cause: error },
    );
  }
}
