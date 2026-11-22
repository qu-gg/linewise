import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameRequest } from '../rename-policy.js';
import { installNativeRename } from '../native-rename.js';
import type { NativeEditApi } from '../native-edit.js';
import { randomUUID } from 'node:crypto';
import type { RenameImage } from '../host-rename.js';
import {
  fixture,
  reset,
  seedFile,
  Document,
  Uri,
  Range,
  Position,
  FileType,
} from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { renameWorkspace } = await import('../host-rename.js');
const { HostTools } = await import('../host-tools.js');
const { WorkspaceFiles } = await import('../workspace.js');
const { ReviewJournal, PathGuard } = await import('../review.js');

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-rename-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  const documents: Document[] = [];
  for (const name of ['main.ts', 'other.ts', 'private/secret.ts']) {
    const target = path.join(cwd, name);
    await writeFile(target, 'const rate = 7;\n');
    seedFile(target, 'const rate = 7;\n');
    const document = new Document(Uri.file(target), 'const rate = 7;\n');
    document.isDirty = false;
    fixture.documents.push(document);
    documents.push(document);
  }
  const abort = new AbortController();
  const scope = { cwd, privateRoot, signal: abort.signal, valid: () => true };
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const writes: RenameImage[] = [];
  const input = {
    path: 'main.ts',
    line: 1,
    column: 7,
    newName: 'price',
    paths: ['main.ts', 'other.ts'],
  };
  const edit = (start = 6, end = 10, newText = 'price') => ({
    range: new Range(new Position(0, start), new Position(0, end)),
    newText,
  });
  const result = (
    entries: [Uri, unknown[]][] = documents.slice(0, 2).map((document) => [document.uri, [edit()]]),
  ) => ({ size: entries.length, entries: () => entries });
  fixture.commands.set('vscode.executeDocumentRenameProvider', () => result());
  const invoke = (change: object = {}) =>
    renameWorkspace(renameRequest.parse({ ...input, ...change }), scope, async (image) => {
      writes.push(image);
    });
  context.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, abort, scope, documents, input, edit, result, writes, invoke };
}

test('rename policy accepts bounded explicit captures and rejects extra authority', () => {
  const input = { path: 'a.ts', line: 1, column: 1, newName: 'newName', paths: ['a.ts'] };
  assert.equal(renameRequest.safeParse(input).success, true);
  for (const change of [
    { line: 0 },
    { column: 0 },
    { paths: [] },
    { paths: Array(9).fill('a.ts') },
    { newName: 'bad name' },
    { newName: '\0' },
    { newName: 'a'.repeat(257) },
    { command: 'arbitrary' },
  ])
    assert.equal(renameRequest.safeParse({ ...input, ...change }).success, false);
});

test('rename captures cross-file text before provider and produces review postimages only', async (context) => {
  const current = await setup(context);
  const result = JSON.parse(await current.invoke());
  assert.deepEqual(result, {
    files: ['main.ts', 'other.ts'],
    completed: 2,
    review: 'pending',
    textOnly: true,
  });
  assert.deepEqual(
    current.writes.map(({ before, content }) => [before, content]),
    [
      ['const rate = 7;\n', 'const price = 7;\n'],
      ['const rate = 7;\n', 'const price = 7;\n'],
    ],
  );
  assert.equal(fixture.commandCalls[0]!.id, 'vscode.executeDocumentRenameProvider');
  assert.deepEqual(fixture.commandCalls[0]!.args.slice(1), [new Position(0, 6), 'price']);
  assert.equal(current.documents[0]!.getText(), 'const rate = 7;\n');
});

test('rename refuses private, outside, aliased, duplicated, missing and unsaved captures', async (context) => {
  const current = await setup(context);
  for (const paths of [
    ['private/secret.ts'],
    ['/outside.ts'],
    ['main.ts', 'main.ts'],
    ['other.ts'],
    ['missing.ts'],
  ])
    await assert.rejects(current.invoke({ paths }));
  await symlink(path.join(current.cwd, 'main.ts'), path.join(current.cwd, 'alias.ts'));
  await assert.rejects(current.invoke({ paths: ['alias.ts'] }), /canonical/);
  current.documents[0]!.isDirty = true;
  await assert.rejects(current.invoke(), /Save rename/);
  current.documents[0]!.isDirty = false;
  fixture.disk.get(path.join(current.cwd, 'main.ts'))!.type = FileType.Directory;
  await assert.rejects(current.invoke(), /regular text/);
  assert.equal(current.writes.length, 0);
});

test('rename refuses absent, excessive, uncaptured and unsafe provider edits before any write', async (context) => {
  const current = await setup(context);
  const uri = current.documents[0]!.uri;
  const cases = [
    undefined,
    current.result([]),
    current.result([[uri, []]]),
    current.result([[Uri.file(path.join(current.cwd, 'private/secret.ts')), [current.edit()]]]),
    current.result([[Uri.file(path.join(current.cwd, 'missing.ts')), [current.edit()]]]),
    current.result([[Uri.parse('untitled:///main.ts'), [current.edit()]]]),
    current.result([[new Uri('file', 'host', uri.path), [current.edit()]]]),
    current.result([
      [uri, [current.edit()]],
      [uri, [current.edit()]],
    ]),
    current.result([[uri, [current.edit(999)]]]),
    current.result([[uri, [current.edit(10, 6)]]]),
    current.result([[uri, [current.edit(6, 10), current.edit(7, 9)]]]),
    current.result([[uri, [current.edit(6, 10), current.edit(6, 6)]]]),
    current.result([[uri, [current.edit(6, 10, '\0')]]]),
    current.result([[uri, [current.edit(6, 10, '#!')]]]),
    current.result([[uri, [current.edit(6, 10, 'rate')]]]),
    current.result([[uri, [current.edit(-1)]]]),
    current.result([[uri, [current.edit(6.5)]]]),
    current.result([[uri, [{ range: current.edit().range, newText: {} }]]]),
    current.result([[uri, Array(1001).fill(current.edit())]]),
    current.result(Array(9).fill([uri, [current.edit()]])),
  ];
  for (const result of cases) {
    fixture.commands.set('vscode.executeDocumentRenameProvider', () => result);
    await assert.rejects(current.invoke());
    assert.equal(current.writes.length, 0);
  }
});

test('rename rejects changed buffers, versions, disk images and retired owners', async (context) => {
  const current = await setup(context);
  const document = current.documents[0]!;
  for (const change of [
    () => {
      document.version++;
    },
    () => {
      document.isDirty = true;
    },
    () => {
      document.text = 'changed';
    },
    () => seedFile(document.uri.path, 'changed'),
  ]) {
    fixture.commands.set('vscode.executeDocumentRenameProvider', () => {
      change();
      return current.result();
    });
    await assert.rejects(current.invoke(), /stale/);
    document.text = 'const rate = 7;\n';
    document.isDirty = false;
    seedFile(document.uri.path, document.text);
  }
  current.scope.valid = () => false;
  await assert.rejects(current.invoke(), /retired/);
  assert.equal(current.writes.length, 0);
});

test('Stop releases a stalled rename provider and late results cannot write', async (context) => {
  const current = await setup(context);
  let started!: () => void;
  let finish!: (value: unknown) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.commands.set('vscode.executeDocumentRenameProvider', () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = current.invoke();
  await ready;
  current.abort.abort(new Error('Stopped rename'));
  await assert.rejects(pending, /Stopped rename/);
  finish(current.result());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.writes.length, 0);
  await assert.rejects(current.invoke(), /Stopped rename/);
});

test('rename reports partial durable writes without retrying or claiming atomicity', async (context) => {
  const current = await setup(context);
  let writes = 0;
  await assert.rejects(
    renameWorkspace(renameRequest.parse(current.input), current.scope, async () => {
      writes++;
      if (writes === 2) throw new Error('conflict');
    }),
    /1 rename files completed/,
  );
  assert.equal(writes, 2);
});

test('registered rename traverses host consent and the durable journal with recoverable provenance', async (context) => {
  const current = await setup(context);
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  const handlers = new Map<string, (...args: any[]) => any>();
  installNativeRename({
    registerTool: (value) => {
      tool = value;
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
  } as NativeEditApi);
  assert.equal(tool.approval, 'write');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const id = randomUUID();
  const native = { cwd: current.cwd, sessionManager: { getSessionId: () => 'native' } };
  const execute = () => tool.execute(id, current.input, current.scope.signal, undefined, native);
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = current.scope.privateRoot;
  const files = new WorkspaceFiles(Uri.file(current.cwd) as any);
  let persisted = '[]';
  const journal = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async (changes) => {
      persisted = JSON.stringify(changes);
    },
  );
  const tools = new HostTools(files, journal, path.join(current.scope.privateRoot, 'mutations'));
  await tools.run(
    { ...current.scope, sessionId: 'native', owner: 'local', turnId: 'turn', valid: () => true },
    async () => {
      await handlers.get('tool_call')!({ toolName: 'other' });
      await handlers.get('tool_result')!({ toolName: 'other' });
      await handlers.get('tool_call')!({
        toolName: 'rename',
        toolCallId: id,
        input: current.input,
      });
      const permission = {
        sessionId: 'native',
        toolCall: { toolCallId: id, rawInput: current.input },
        options: [{ kind: 'allow_once', optionId: 'once', name: 'Allow Once' }],
      };
      assert.deepEqual(await tools.permission(permission as any), {
        outcome: { outcome: 'selected', optionId: 'once' },
      });
      const result = (await execute()) as { content: { text: string }[] };
      assert.equal(JSON.parse(result.content[0]!.text).completed, 2);
      await handlers.get('tool_result')!({ toolName: 'rename', toolCallId: id });
    },
  );
  const reopened = new ReviewJournal(
    files,
    new PathGuard([current.cwd]),
    async () => false,
    async () => {},
    JSON.parse(persisted),
  );
  assert.equal(reopened.list().length, 2);
  for (const change of reopened.list()) {
    assert.equal(change.operations![0]!.tool, 'rename');
    assert.equal(change.operations![0]!.toolCallId, id);
    assert.match((await files.read(change.path))!, /price/);
    await reopened.discard(change.id);
    assert.equal(await files.read(change.path), 'const rate = 7;\n');
  }
  assert.equal(reopened.list().length, 0);
  await assert.rejects(
    tool.execute(id, current.input, AbortSignal.abort(new Error('Stopped')), undefined, native),
    /Stopped/,
  );
});

test('rename bounds captures, encodings and replacement bytes before applying text', async (context) => {
  const current = await setup(context);
  const document = current.documents[0]!;
  fixture.configuration.set('files.encoding', 'utf16le');
  await assert.rejects(current.invoke(), /UTF-8/);
  fixture.configuration.clear();
  seedFile(document.uri.path, new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(document.text)]));
  await assert.rejects(current.invoke(), /BOM/);
  seedFile(document.uri.path, new Uint8Array([0xff]));
  await assert.rejects(current.invoke());
  seedFile(document.uri.path, document.text);
  for (const text of ['x'.repeat(1_048_577), '\0']) {
    document.text = text;
    seedFile(document.uri.path, text);
    await assert.rejects(current.invoke(), /Save rename|regular text|4 MiB/);
  }
  document.text = 'const rate = 7;\n';
  seedFile(document.uri.path, document.text);
  fixture.commands.set('vscode.executeDocumentRenameProvider', () =>
    current.result([[document.uri, [current.edit(6, 10, 'x'.repeat(1_048_577))]]]),
  );
  await assert.rejects(current.invoke(), /bounded plain text/);
  fixture.commands.set('vscode.executeDocumentRenameProvider', () =>
    current.result([
      [
        document.uri,
        [current.edit(6, 10, 'x'.repeat(600_000)), current.edit(0, 0, 'y'.repeat(600_000))],
      ],
    ]),
  );
  await assert.rejects(current.invoke(), /replacement text/);
  assert.equal(current.writes.length, 0);
});
