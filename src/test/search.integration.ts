import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { isRefactorInvocation } from './live-code-actions.js';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectEditor } from '../host-inspect.js';
import { editorRequest } from '../editor-policy.js';
import { codeActionRequest } from '../code-action-policy.js';
import { codeActionsWorkspace } from '../host-code-actions.js';
import { nativeReviewedRefactor, refactorFixtures } from './code-actions.integration.js';

const counts = [32, 256, 10000] as const;
const signal = AbortSignal.timeout(180000);

function filename(index: number) {
  return `part-${String(index).padStart(5, '0')}.txt`;
}
function anchor(index: number) {
  return `INDEX_ANCHOR_${String(index).padStart(5, '0')}`;
}

async function scale(root: string, count: number) {
  const directory = path.join(root, `scale-${count}`);
  await mkdir(directory, { mode: 0o700 });
  const size = count === 256 ? 16384 : 256;
  for (let offset = 0; offset < count; offset += 64) {
    signal.throwIfAborted();
    await Promise.all(
      Array.from({ length: Math.min(64, count - offset) }, (_, position) => {
        const index = offset + position;
        return writeFile(
          path.join(directory, filename(index)),
          `${anchor(index)}\n`.padEnd(size, ' '),
          { mode: 0o600 },
        );
      }),
    );
  }
  return directory;
}

async function query(cwd: string, text: string) {
  return JSON.parse(
    await inspectEditor(
      editorRequest.parse({
        action: 'search',
        glob: '**/*.txt',
        query: text,
        limit: 100,
      }),
      { cwd, privateRoot: path.join(cwd, 'private'), signal },
    ),
  );
}

async function measured(small: string, complete: string) {
  const coldMs: number[] = [];
  const coldPeakRssKiB: number[] = [];
  for (let run = 0; run < 5; run++) {
    await query(small, anchor(0));
    const started = performance.now();
    const result = await query(complete, anchor(0));
    coldMs.push(performance.now() - started);
    coldPeakRssKiB.push(process.resourceUsage().maxRSS);
    assert.equal(result.indexedFiles, 256);
    assert.equal(result.indexedBytes, 4_194_304);
    assert.equal(result.items.length, 1);
    assert.ok(coldMs[run]! <= 10000, 'Cold index build exceeds the frozen ten-second limit.');
  }
  const generation = (await query(complete, anchor(0))).generation;
  const warmMs: number[] = [];
  for (let run = 0; run < 50; run++) {
    const started = performance.now();
    const result = await query(complete, anchor(run));
    warmMs.push(performance.now() - started);
    assert.equal(result.generation, generation);
    assert.equal(result.items[0].path, filename(run));
  }
  const ordered = [...warmMs].sort((first, second) => first - second);
  const warmP95Ms = ordered[Math.ceil(ordered.length * 0.95) - 1]!;
  assert.ok(warmP95Ms <= 1000, 'Warm p95 exceeds the frozen one-second limit.');
  return {
    coldMs,
    coldPeakRssKiB,
    memoryDefinition:
      'cumulative extension-host process high-water RSS; excludes other workbench processes',
    warmMs,
    warmP95Ms,
    peakRssKiB: process.resourceUsage().maxRSS,
    coldDefinition: 'root cache evicted; editor and OS caches not flushed',
  };
}

interface SemanticFixture {
  sources: Record<string, string>;
  queries: { query: string; expected: string; nonliteral: boolean; symbol: string }[];
  budgets: { topFiveMinimum: number; nonliteralMinimum: number; queryMs: number };
}

async function prepareSemantic(root: string) {
  const fixture = JSON.parse(
    await readFile(process.env.VS_OMP_SEMANTIC_FIXTURE!, 'utf8'),
  ) as SemanticFixture;
  const cwd = path.join(root, 'semantic');
  for (const [relative, text] of Object.entries(fixture.sources)) {
    const target = path.join(cwd, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600 });
  }
  await vscode.extensions.getExtension('vscode.typescript-language-features')!.activate();
  for (const relative of Object.keys(fixture.sources).filter((name) => name.endsWith('.ts'))) {
    const uri = vscode.Uri.file(path.join(cwd, relative));
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  }
  const scope = { cwd, privateRoot: path.join(cwd, 'private'), signal };
  const inspect = async (input: unknown) =>
    JSON.parse(await inspectEditor(editorRequest.parse(input), scope));
  return { fixture, cwd, inspect };
}

async function semanticQueries(current: Awaited<ReturnType<typeof prepareSemantic>>) {
  const rows = [];
  let matched = 0;
  let nonliteral = 0;
  for (const entry of current.fixture.queries) {
    const started = performance.now();
    const result = await current.inspect({
      action: 'semanticSearch',
      backend: 'local-lsa-v1',
      query: entry.query,
      glob: '**/*.{ts,py}',
      limit: 5,
    });
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs <= current.fixture.budgets.queryMs);
    const found = result.items.some((item: { path: string }) => item.path === entry.expected);
    matched += Number(found);
    nonliteral += Number(found && entry.nonliteral);
    const lexical = await current.inspect({
      action: 'search',
      query: entry.query,
      glob: '**/*.{ts,py}',
      caseSensitive: false,
      limit: 100,
    });
    const symbols = await current.inspect({
      action: 'workspaceSymbols',
      query: entry.symbol,
      limit: 5,
    });
    const symbolFound = symbols.items.some(
      (item: { path: string }) => item.path === entry.expected,
    );
    if (entry.expected.endsWith('.ts')) assert.equal(symbolFound, true);
    if (entry.nonliteral) assert.equal(lexical.items.length, 0);
    assert.equal(result.backend, 'local-lsa-v1');
    assert.equal(result.stale, false);
    assert.equal(result.inferenceRequests, 0);
    rows.push({
      expected: entry.expected,
      found,
      nonliteral: entry.nonliteral,
      elapsedMs,
      lexicalHits: lexical.items.length,
      symbolFound,
    });
  }
  assert.ok(matched >= current.fixture.budgets.topFiveMinimum);
  assert.ok(nonliteral >= current.fixture.budgets.nonliteralMinimum);
  return {
    matched,
    nonliteral,
    rows,
    pythonSymbolProvider: vscode.extensions.getExtension('ms-python.python')?.id ?? null,
  };
}

async function semanticFreshness(
  current: Awaited<ReturnType<typeof prepareSemantic>>,
  root: string,
) {
  const relative = 'billing/invoice.ts';
  const target = path.join(current.cwd, relative);
  const before = await readFile(target, 'utf8');
  const document = await vscode.workspace.openTextDocument(target);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(before.length)),
    'export const nativeCancelledMessages = true;\n',
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const query = async (text: string, backend = 'local-lsa-v1') =>
    current.inspect({
      action: 'semanticSearch',
      backend,
      query: text,
      glob: '**/*.{ts,py}',
      limit: 5,
    });
  const overlay = await query('native cancelled messages');
  assert.ok(overlay.items.some((item: { path: string }) => item.path === relative));
  assert.equal(overlay.overlayFiles, 1);
  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal((await query('quantity', 'missing')).unavailable, true);
  await mkdir(path.join(current.cwd, 'private'));
  await writeFile(path.join(current.cwd, 'private/secret.py'), 'PRIVATESEMANTICCANARY', {
    mode: 0o600,
  });
  const outside = path.join(root, 'semantic-outside.py');
  await writeFile(outside, 'PRIVATESEMANTICCANARY', { mode: 0o600 });
  await symlink(outside, path.join(current.cwd, 'outside-alias.py'));
  assert.equal((await query('PRIVATESEMANTICCANARY')).items.length, 0);
  const abort = new AbortController();
  abort.abort(new Error('Stopped native semantic capture'));
  await assert.rejects(
    inspectEditor(
      editorRequest.parse({ action: 'semanticSearch', backend: 'local-lsa-v1', query: 'quantity' }),
      { cwd: current.cwd, privateRoot: path.join(current.cwd, 'private'), signal: abort.signal },
    ),
    /Stopped native semantic capture/,
  );
  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal(document.isDirty, true);
}

async function semanticSavedFreshness(current: Awaited<ReturnType<typeof prepareSemantic>>) {
  const original = path.join(current.cwd, 'lifecycle.ts');
  const moved = path.join(current.cwd, 'lifecycle-renamed.ts');
  await writeFile(original, 'export const originalLifecycleCanary = true;\n', { mode: 0o600 });
  const query = async (text: string) =>
    current.inspect({
      action: 'semanticSearch',
      backend: 'local-lsa-v1',
      query: text,
      glob: '**/*.{ts,py}',
      limit: 100,
    });
  const first = await query('original lifecycle canary');
  assert.ok(first.items.some((item: { path: string }) => item.path === 'lifecycle.ts'));
  await writeFile(original, 'export const replacementLifecycleCanary = true;\n', { mode: 0o600 });
  const saved = await query('replacement lifecycle canary');
  assert.equal(saved.stale, false);
  assert.ok(saved.generation > first.generation);
  const changed = saved.items.find((item: { path: string }) => item.path === 'lifecycle.ts');
  assert.ok(changed.preview.includes('replacementLifecycleCanary'));
  await rename(original, moved);
  const renamed = await query('replacement lifecycle canary');
  assert.ok(renamed.items.some((item: { path: string }) => item.path === 'lifecycle-renamed.ts'));
  assert.ok(renamed.items.every((item: { path: string }) => item.path !== 'lifecycle.ts'));
  await writeFile(path.join(current.cwd, '.ignore'), 'lifecycle-renamed.ts\n', { mode: 0o600 });
  assert.ok(
    (await query('replacement lifecycle canary')).items.every(
      (item: { path: string }) => item.path !== 'lifecycle-renamed.ts',
    ),
  );
  await rm(path.join(current.cwd, '.ignore'));
  assert.ok(
    (await query('replacement lifecycle canary')).items.some(
      (item: { path: string }) => item.path === 'lifecycle-renamed.ts',
    ),
  );
  await rm(moved);
  assert.ok(
    (await query('replacement lifecycle canary')).items.every(
      (item: { path: string }) => item.path !== 'lifecycle-renamed.ts',
    ),
  );
  return { saved: true, renamed: true, deleted: true, changedIgnores: true };
}

async function freshness(cwd: string, root: string) {
  const target = path.join(cwd, filename(0));
  const saved = await readFile(target, 'utf8');
  const document = await vscode.workspace.openTextDocument(target);
  const edits = new vscode.WorkspaceEdit();
  edits.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(saved.length)),
    'NATIVE_UNSAVED_INDEX',
  );
  assert.equal(await vscode.workspace.applyEdit(edits), true);
  assert.equal(document.isDirty, true);
  const overlay = await query(cwd, 'NATIVE_UNSAVED_INDEX');
  assert.equal(overlay.items[0].path, filename(0));
  assert.equal(overlay.overlayFiles, 1);
  assert.equal(await readFile(target, 'utf8'), saved);
  await rename(path.join(cwd, filename(1)), path.join(cwd, 'renamed.txt'));
  assert.equal((await query(cwd, anchor(1))).items[0].path, 'renamed.txt');
  await rm(path.join(cwd, filename(2)));
  assert.equal((await query(cwd, anchor(2))).items.length, 0);
  await writeFile(path.join(cwd, '.ignore'), `${filename(3)}\n`, { mode: 0o600 });
  assert.equal((await query(cwd, anchor(3))).items.length, 0);
  await mkdir(path.join(cwd, 'private'));
  await writeFile(path.join(cwd, 'private/secret.txt'), 'PRIVATE_INDEX_SECRET', { mode: 0o600 });
  const outside = path.join(root, 'outside-secret.txt');
  await writeFile(outside, 'PRIVATE_INDEX_SECRET', { mode: 0o600 });
  await symlink(outside, path.join(cwd, 'outside-alias.txt'));
  assert.equal((await query(cwd, 'PRIVATE_INDEX_SECRET')).items.length, 0);
}

async function refactorInvocation(
  request: Parameters<typeof codeActionsWorkspace>[0],
  scope: Parameters<typeof codeActionsWorkspace>[1],
) {
  let invoked = 0;
  const provider = vscode.languages.registerCodeActionsProvider(
    { language: 'typescript', scheme: 'file' },
    {
      provideCodeActions: (_document, _range, context) => {
        if (isRefactorInvocation(context)) invoked++;
        return [];
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.Refactor.append('rewrite.export.default')] },
  );
  try {
    await codeActionsWorkspace(
      codeActionRequest.parse({
        ...request,
        line: 1,
        column: 17,
        endLine: 1,
        endColumn: 29,
        kind: 'refactor.rewrite.export.default',
      }),
      scope,
      async () => {
        throw new Error('Invocation context probe must not write.');
      },
    );
    assert.equal(invoked, 1);
    return { exactInvocations: invoked };
  } finally {
    provider.dispose();
  }
}

async function providerBoundary(root: string) {
  const cwd = path.join(root, 'refactor');
  await mkdir(cwd, { mode: 0o700 });
  const { source, usage, before, references } = await refactorFixtures(vscode.Uri.file(cwd));
  const scope = {
    cwd,
    privateRoot: path.join(cwd, 'private'),
    signal,
    valid: () => !signal.aborted,
  };
  const request = codeActionRequest.parse({
    action: 'list',
    path: source.fsPath,
    line: 2,
    column: 3,
    endLine: 3,
    endColumn: 21,
    kind: 'refactor',
    title: null,
    paths: [source.fsPath, usage.fsPath],
  });
  const listed = JSON.parse(
    await codeActionsWorkspace(request, scope, async () => {
      throw new Error('Refactor discovery must not write.');
    }),
  );
  const crossFile = JSON.parse(
    await codeActionsWorkspace(
      codeActionRequest.parse({ ...request, line: 1, column: 17, endLine: 1, endColumn: 29 }),
      scope,
      async () => {
        throw new Error('Cross-file refactor discovery must not write.');
      },
    ),
  );
  const mixed = new vscode.WorkspaceEdit();
  mixed.insert(source, new vscode.Position(0, 0), 'NOT_APPLIED');
  mixed.createFile(vscode.Uri.file(path.join(cwd, 'created.ts')));
  mixed.renameFile(source, vscode.Uri.file(path.join(cwd, 'moved.ts')));
  mixed.deleteFile(usage);
  const entries = mixed.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]![1].length, 1);
  assert.equal(await readFile(source.fsPath, 'utf8'), before);
  assert.equal(await readFile(usage.fsPath, 'utf8'), references);
  const provider = vscode.extensions.getExtension('vscode.typescript-language-features')!;
  const invocation = await refactorInvocation(request, scope);
  const review = await nativeReviewedRefactor(vscode.Uri.file(cwd));
  return {
    provider: provider.id,
    version: provider.packageJSON.version,
    invocation,
    refactorActions: listed.actions,
    crossFileActions: crossFile.actions,
    review,
    resourceOperationsConstructed: 3,
    publicEditSize: mixed.size,
    inspectedTextEntries: entries.length,
    orderedResourceMetadataExposed: false,
    workspaceMutated: false,
  };
}

export async function run() {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const report: Record<string, unknown> = {
    passed: false,
    counts,
    node: process.versions.node,
    vscode: vscode.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    totalMemoryBytes: os.totalmem(),
    inferenceRequests: 0,
  };
  try {
    const directories = [];
    for (const count of counts) directories.push(await scale(root, count));
    const [small, complete, large] = directories as [string, string, string];
    assert.equal((await query(small, 'INDEX_ANCHOR_')).indexedFiles, 32);
    const partial = await query(large, 'INDEX_ANCHOR_');
    assert.equal(partial.limited, true);
    assert.equal(partial.coverage, 'partial');
    assert.ok(partial.indexedFiles <= 256 && partial.indexedBytes <= 4_194_304);
    report.measurements = await measured(small, complete);
    report.large = {
      indexedFiles: partial.indexedFiles,
      indexedBytes: partial.indexedBytes,
      limited: partial.limited,
      coverage: partial.coverage,
    };
    await freshness(complete, root);
    const semantic = await prepareSemantic(root);
    report.semantic = await semanticQueries(semantic);
    await semanticFreshness(semantic, root);
    report.semanticSavedFreshness = await semanticSavedFreshness(semantic);
    report.providerBoundary = await providerBoundary(root);
    report.passed = true;
  } catch (error) {
    report.failureKind = error instanceof Error ? error.name : 'unknown';
    throw error;
  } finally {
    await writeFile(process.env.VS_OMP_SEARCH_REPORT!, JSON.stringify(report), {
      mode: 0o600,
      flag: 'wx',
    });
  }
}
