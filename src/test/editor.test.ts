import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { editorRequest } from '../editor-policy.js';
import { installNativeEditor } from '../native-editor.js';
import type { NativeEditApi } from '../native-edit.js';
import {
  fixture,
  reset,
  seedFile,
  Uri,
  Range,
  Position,
  Document,
  ProcessExecution,
  ShellExecution,
} from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { inspectEditor } = await import('../host-inspect.js');
const { HostTools } = await import('../host-tools.js');

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-editor-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  for (const name of ['main.ts', 'other.ts', 'private/secret.ts']) {
    await writeFile(path.join(cwd, name), 'export const rate = 7;\n');
    seedFile(path.join(cwd, name), 'export const rate = 7;\n');
  }
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const scope = { cwd, privateRoot, signal: abort.signal };
  const invoke = async (input: unknown) =>
    JSON.parse(await inspectEditor(editorRequest.parse(input), scope));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, abort, scope, invoke };
}

function range() {
  return new Range(new Position(1, 2), new Position(1, 6));
}

test('editor schema accepts only bounded read-only services with explicit positions', () => {
  for (const input of [
    { action: 'files', glob: '**/*.ts' },
    { action: 'diagnostics' },
    { action: 'symbols', path: 'main.ts' },
    { action: 'references', path: 'main.ts', line: 1, column: 1 },
  ])
    assert.equal(editorRequest.safeParse(input).success, true);
  for (const input of [
    { action: 'execute', command: 'arbitrary' },
    { action: 'diagnostics', limit: 101 },
    { action: 'symbols', path: '' },
    { action: 'definitions', path: 'main.ts', line: 0, column: 1 },
    { action: 'files', glob: '**', content: 'mutation' },
  ])
    assert.equal(editorRequest.safeParse(input).success, false);
});

test('diagnostics expose only workspace targets and can select a single file', async (context) => {
  const current = await setup(context);
  const entry = { message: 'A real diagnostic', severity: 0, range: range() };
  fixture.diagnostics = [
    [Uri.file(path.join(current.cwd, 'main.ts')), [entry]],
    [Uri.file(path.join(current.cwd, 'other.ts')), [entry]],
    [Uri.file(path.join(current.cwd, 'private/secret.ts')), [entry]],
    [Uri.file('/outside.ts'), [entry]],
    [Uri.parse('untitled:///unrelated'), [entry]],
  ];
  const result = await current.invoke({ action: 'diagnostics' });
  assert.deepEqual(
    result.items.map((item: { path: string }) => item.path),
    ['main.ts', 'other.ts'],
  );
  assert.equal(result.items[0].line, 2);
  assert.equal(result.items[0].column, 3);
  assert.equal(result.limited, false);
  assert.equal((await current.invoke({ action: 'diagnostics', path: 'other.ts' })).items.length, 1);
  await assert.rejects(current.invoke({ action: 'diagnostics', path: '/outside.ts' }));
});

test('file discovery filters private results and bounds counts and diagnostic bytes', async (context) => {
  const current = await setup(context);
  const result = await current.invoke({ action: 'files', glob: '**/*.ts', limit: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.limited, true);
  const files = await current.invoke({ action: 'files', glob: '**/*.ts' });
  assert.deepEqual(
    files.items.map((item: { path: string }) => item.path),
    ['main.ts', 'other.ts'],
  );
  fixture.diagnostics = [
    [
      Uri.file(path.join(current.cwd, 'main.ts')),
      Array.from({ length: 101 }, () => ({
        message: 'large'.repeat(1000),
        severity: 1,
        range: range(),
      })),
    ],
  ];
  const bounded = await current.invoke({ action: 'diagnostics', limit: 100 });
  assert.ok(bounded.items.length > 0 && bounded.items.length < 100);
  assert.equal(bounded.limited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 64_000);
});

test('symbols retain child symbols, handle legacy locations and filter private provider results', async (context) => {
  const current = await setup(context);
  const child = { name: 'quote', kind: 11, range: range(), children: [] };
  fixture.commands.set('vscode.executeDocumentSymbolProvider', () => [
    { name: 'Rate', kind: 4, range: range(), children: [child] },
    {
      name: 'legacy',
      kind: 12,
      location: { uri: Uri.file(path.join(current.cwd, 'other.ts')), range: range() },
    },
    {
      name: 'secret',
      kind: 12,
      location: { uri: Uri.file(path.join(current.cwd, 'private/secret.ts')), range: range() },
    },
  ]);
  const result = await current.invoke({ action: 'symbols', path: 'main.ts' });
  assert.deepEqual(
    result.items.map((item: { name: string }) => item.name),
    ['Rate', 'legacy', 'quote'],
  );
  fixture.commands.clear();
  assert.deepEqual((await current.invoke({ action: 'symbols', path: 'main.ts' })).items, []);
});

test('definitions and references preserve one-based coordinates and both location shapes', async (context) => {
  const current = await setup(context);
  const entries = [
    { uri: Uri.file(path.join(current.cwd, 'main.ts')), range: range() },
    { targetUri: Uri.file(path.join(current.cwd, 'other.ts')), targetRange: range() },
    {
      targetUri: Uri.file(path.join(current.cwd, 'other.ts')),
      targetRange: range(),
      targetSelectionRange: range(),
    },
    { uri: Uri.file('/outside.ts'), range: range() },
  ];
  fixture.commands.set('vscode.executeDefinitionProvider', () => entries);
  fixture.commands.set('vscode.executeReferenceProvider', () => entries);
  for (const action of ['definitions', 'references']) {
    const result = await current.invoke({ action, path: 'main.ts', line: 2, column: 3 });
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0].column, 3);
    assert.deepEqual(fixture.commandCalls.at(-1)!.args[1], new Position(1, 2));
  }
});

test('Stop cancels inspection even when a language provider never completes', async (context) => {
  const current = await setup(context);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.commands.set('vscode.executeDocumentSymbolProvider', () => {
    started();
    return new Promise(() => {});
  });
  const pending = current.invoke({ action: 'symbols', path: 'main.ts' });
  await ready;
  current.abort.abort(new Error('Stopped inspection'));
  await assert.rejects(pending, /Stopped inspection/);
  await assert.rejects(current.invoke({ action: 'diagnostics' }), /Stopped inspection/);
});

test('literal search is case-aware, bounded, private-filtered and includes unsaved text', async (context) => {
  const current = await setup(context);
  seedFile(path.join(current.cwd, 'main.ts'), 'A+B\nrate RATE\n');
  const result = await current.invoke({ action: 'search', query: 'A+B' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, 'main.ts');
  assert.equal(result.items[0].line, 1);
  assert.equal(
    (await current.invoke({ action: 'search', query: 'rate', caseSensitive: false, limit: 1 }))
      .limited,
    true,
  );
  const document = fixture.documents.find(
    (item) => item.uri.fsPath === path.join(current.cwd, 'main.ts'),
  )!;
  document.text = 'UNSAVED_LITERAL_SENTINEL';
  assert.equal(
    (await current.invoke({ action: 'search', query: 'UNSAVED_LITERAL_SENTINEL' })).items.length,
    1,
  );
  fixture.disk.get(path.join(current.cwd, 'main.ts'))!.size = 2_000_000;
  const skipped = await current.invoke({ action: 'search', query: 'rate' });
  assert.equal(skipped.skippedFiles, 1);
  assert.equal(skipped.limited, true);
  assert.ok(skipped.items.every((item: { path: string }) => !item.path.includes('private')));
});

test('indexed search reuses warm generations and refreshes unsaved and deleted sources', async (context) => {
  const current = await setup(context);
  await current.invoke({ action: 'search', query: 'rate' });
  for (const document of fixture.documents) document.isDirty = false;
  const first = await current.invoke({ action: 'search', query: 'rate' });
  const second = await current.invoke({ action: 'search', query: 'export' });
  assert.equal(second.generation, first.generation);
  assert.equal(second.index, 'lexical');
  assert.equal(second.stale, false);
  const document = fixture.documents.find(
    (item) => item.uri.fsPath === path.join(current.cwd, 'main.ts'),
  )!;
  document.text = 'CHANGED_INDEX_SOURCE';
  document.isDirty = true;
  const changed = await current.invoke({ action: 'search', query: 'CHANGED_INDEX_SOURCE' });
  assert.ok(changed.generation > first.generation);
  assert.equal(changed.overlayFiles, 1);
  assert.equal(changed.items[0].path, 'main.ts');
  fixture.disk.delete(path.join(current.cwd, 'main.ts'));
  assert.equal(
    (await current.invoke({ action: 'search', query: 'CHANGED_INDEX_SOURCE' })).items.length,
    0,
  );
});

test('workspace task discovery filters global, private and outside scopes and never starts tasks', async (context) => {
  const current = await setup(context);
  const task = {
    name: 'Check',
    source: 'workspace',
    definition: { type: 'shell', secret: 'NEVER_TASK_DEFINITION' },
  };
  fixture.tasks = [
    { ...task, scope: 1, execution: new ShellExecution() },
    { ...task, scope: fixture.roots[0], execution: new ProcessExecution() },
    { ...task, scope: 2, execution: new ShellExecution() },
    { ...task, scope: 2 },
    { ...task, scope: { uri: Uri.file('/outside') } },
    { ...task, scope: { uri: Uri.file(path.join(current.cwd, 'private')) } },
  ];
  const result = await current.invoke({ action: 'tasks' });
  assert.deepEqual(
    result.items.map((item: { execution: string }) => item.execution),
    ['process', 'shell', 'custom-or-unavailable'],
  );
  assert.ok(!JSON.stringify(result).includes('NEVER_TASK_DEFINITION'));
  assert.equal((await current.invoke({ action: 'tasks', limit: 1 })).limited, true);
  assert.equal(editorRequest.safeParse({ action: 'tasks', execute: true }).success, false);
});

test('notebook inspection reads unsaved cells and bounded text outputs without kernel or edits', async (context) => {
  const current = await setup(context);
  const target = path.join(current.cwd, 'main.ts');
  const document = new Document(Uri.parse('vscode-notebook-cell:/unsaved'), 'UNSAVED_CELL_SOURCE');
  const text = new TextEncoder().encode('Exact output');
  const cell = {
    index: 0,
    kind: 2,
    document: Object.assign(document, { languageId: 'python' }),
    outputs: [
      {
        items: [
          { mime: 'text/plain', data: text },
          { mime: 'image/png', data: text },
        ],
      },
    ],
  };
  fixture.notebook = {
    cellCount: 2,
    notebookType: 'fixture',
    isDirty: true,
    getCells: () => [cell, { ...cell, index: 1 }],
  };
  const result = await current.invoke({ action: 'notebook', path: target, limit: 1 });
  assert.equal(result.items[0].text, 'UNSAVED_CELL_SOURCE');
  assert.equal(result.items[0].dirty, true);
  assert.equal(result.items[0].cell, 1);
  assert.equal(result.items[0].outputs[0].text, 'Exact output');
  assert.equal(result.items[0].outputs[1].text, undefined);
  assert.equal(result.items[0].outputs[1].output, 1);
  assert.equal(result.items[0].outputs[1].item, 2);
  assert.equal(result.limited, true);
  assert.deepEqual(
    (await current.invoke({ action: 'notebook', path: target, startCell: 3 })).items,
    [],
  );
  cell.outputs = Array.from({ length: 10 }, () => ({
    items: Array.from({ length: 10 }, () => ({
      mime: 'text/plain',
      data: new TextEncoder().encode('large'.repeat(1000)),
    })),
  }));
  document.text = 'source'.repeat(2000);
  const bounded = await current.invoke({ action: 'notebook', path: target, limit: 1 });
  assert.equal(bounded.items[0].text.length, 8000);
  assert.equal(bounded.items[0].partial, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 64000);
  await assert.rejects(
    current.invoke({ action: 'notebook', path: path.join(current.cwd, 'private/secret.ts') }),
  );
  await assert.rejects(current.invoke({ action: 'notebook', path: '/outside.ipynb' }));
  fixture.notebook = undefined;
  await assert.rejects(
    current.invoke({ action: 'notebook', path: target }),
    /No notebook provider/,
  );
});

test('registered editor traverses the actual prompt broker without file mutation authority', async (context) => {
  const current = await setup(context);
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeEditor({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  assert.equal(tool.approval, 'read');
  const execute = () =>
    tool.execute(randomUUID(), { action: 'diagnostics' }, current.scope.signal, undefined, {
      cwd: current.cwd,
      sessionManager: { getSessionId: () => 'native' },
    });
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = current.scope.privateRoot;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const tools = new HostTools(
    {
      normalize: async () => {
        throw new Error('No mutation allowed');
      },
    },
    {
      read: async () => '',
      write: async () => {
        throw new Error('No mutation allowed');
      },
    },
    path.join(current.scope.privateRoot, 'mutations'),
  );
  await tools.run(
    { ...current.scope, sessionId: 'native', owner: 'local', valid: () => true },
    async () => {
      const result = (await execute()) as { content: { text: string }[]; isError: boolean };
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(result.content[0]!.text), { items: [], limited: false });
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
        'base64',
      );
      fixture.notebook = {
        cellCount: 1,
        cellAt: () => ({ outputs: [{ items: [{ mime: 'image/png', data: png }] }] }),
      };
      const image = (await tool.execute(
        randomUUID(),
        { action: 'notebookImage', path: 'main.ts', cell: 1, output: 1, item: 1 },
        current.scope.signal,
        undefined,
        { cwd: current.cwd, sessionManager: { getSessionId: () => 'native' } },
      )) as { content: { type: string; data?: string; mimeType?: string }[] };
      assert.equal(image.content[0]!.type, 'image');
      assert.equal(image.content[0]!.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(image.content[0]!.data!, 'base64'), png);
    },
  );
});

test('notebook image reads exact indexed current output and rejects unsafe formats, sizes and scopes', async (context) => {
  const current = await setup(context);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64',
  );
  const item = { mime: 'image/png', data: png };
  fixture.notebook = {
    cellCount: 2,
    cellAt: (index: number) => {
      assert.equal(index, 1);
      return {
        outputs: [
          { items: [{ mime: 'text/plain', data: Buffer.from('text') }] },
          { items: [item] },
        ],
      };
    },
  };
  const input = { action: 'notebookImage', path: 'main.ts', cell: 2, output: 2, item: 1 };
  const result = await current.invoke(input);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.untrusted, true);
  assert.deepEqual(Buffer.from(result.data, 'base64'), png);
  for (const change of [
    { cell: 3 },
    { output: 3 },
    { item: 2 },
    { output: 1 },
    { path: '/outside.ipynb' },
    { path: 'private/secret.ts' },
  ])
    await assert.rejects(current.invoke({ ...input, ...change }));
  for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
    item.mime = mime;
    await assert.rejects(current.invoke(input), /PNG, JPEG or WebP/);
  }
  item.mime = 'image/png';
  for (const data of [Buffer.alloc(0), Buffer.alloc(524289)]) {
    item.data = data;
    await assert.rejects(current.invoke(input), /512 KiB/);
  }
  item.data = Buffer.from('not a PNG');
  await assert.rejects(current.invoke(input), /signature/);
  for (const [mime, data] of [
    ['image/jpeg', Buffer.from([255, 216, 255, 217])],
    ['image/webp', Buffer.from('RIFFxxxxWEBPdata')],
  ] as const) {
    item.mime = mime;
    item.data = data;
    assert.equal((await current.invoke(input)).mimeType, mime);
  }
  for (const change of [{ cell: 0 }, { output: -1 }, { item: 1_000_001 }, { execute: true }])
    assert.equal(editorRequest.safeParse({ ...input, ...change }).success, false);
  current.abort.abort(new Error('Stopped image'));
  await assert.rejects(current.invoke(input), /Stopped image/);
});

test('Stop releases a stalled notebook image open and rejects late output', async (context) => {
  const current = await setup(context);
  let started!: () => void;
  let resume!: (value: unknown) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.notebook = {
    then(resolve: (value: unknown) => void) {
      resume = resolve;
      started();
    },
  };
  const pending = current.invoke({
    action: 'notebookImage',
    path: 'main.ts',
    cell: 1,
    output: 1,
    item: 1,
  });
  await ready;
  current.abort.abort(new Error('Stopped notebook image open'));
  await assert.rejects(pending, /Stopped notebook image/);
  resume({
    cellCount: 1,
    cellAt: () => {
      throw new Error('Late output must never be read');
    },
  });
});
