import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { editorRequest } from '../editor-policy.js';
import { fixture, reset, Uri, Range, Position } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { inspectEditor } = await import('../host-inspect.js');

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-workspace-symbols-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ['main.ts', 'private/secret.ts', 'node_modules/vendor.ts', 'dist/built.ts']) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), 'export const found = 7;\n');
  }
  const abort = new AbortController();
  const scope = { cwd, privateRoot: path.join(cwd, 'private'), signal: abort.signal };
  const invoke = async (input: unknown) =>
    JSON.parse(await inspectEditor(editorRequest.parse(input), scope));
  const symbol = (target: string, name = 'found') => ({
    name,
    kind: 12,
    containerName: 'module',
    location: {
      uri: Uri.file(path.resolve(cwd, target)),
      range: new Range(new Position(1, 2), new Position(1, 6)),
    },
  });
  return { cwd, abort, invoke, symbol };
}

test('workspace symbols are strict, bounded, provider-dependent and private-filtered', async (context) => {
  const current = await setup(context);
  assert.doesNotMatch(JSON.stringify(z.toJSONSchema(editorRequest)), /\\p\{/u);
  assert.equal(
    editorRequest.safeParse({ action: 'workspaceSymbols', query: '   ' }).success,
    false,
  );
  for (const request of [
    { action: 'workspaceSymbols', query: '' },
    { action: 'workspaceSymbols', query: 'x'.repeat(201) },
    { action: 'workspaceSymbols', query: 'bad\u200bquery' },
    { action: 'workspaceSymbols', query: 'found', path: '/outside.ts' },
  ])
    assert.equal(editorRequest.safeParse(request).success, false);
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () => [
    current.symbol('private/secret.ts', 'NEVER_PRIVATE'),
    current.symbol('node_modules/vendor.ts'),
    current.symbol('dist/built.ts'),
    current.symbol('/outside.ts'),
    {
      ...current.symbol('main.ts'),
      location: { ...current.symbol('main.ts').location, uri: Uri.parse('untitled:///unshared') },
    },
    current.symbol('main.ts'),
  ]);
  const result = await current.invoke({ action: 'workspaceSymbols', query: 'found' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, 'main.ts');
  assert.equal(result.items[0].line, 2);
  assert.equal(result.items[0].column, 3);
  assert.equal(result.providerDependent, true);
  assert.equal(result.untrusted, true);
  assert.equal(result.limited, false);
  assert.equal(result.inspectedSymbols, 6);
  assert.deepEqual(fixture.commandCalls.at(-1)!.args, ['found']);
  assert.ok(!JSON.stringify(result).includes('NEVER_PRIVATE'));
});

test('workspace symbol result scans and serialized output are bounded without claiming completeness', async (context) => {
  const current = await setup(context);
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () =>
    Array.from({ length: 1001 }, () => current.symbol('private/secret.ts')),
  );
  const excluded = await current.invoke({ action: 'workspaceSymbols', query: 'found' });
  assert.equal(excluded.inspectedSymbols, 1000);
  assert.equal(excluded.limited, true);
  assert.deepEqual(excluded.items, []);
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () =>
    Array.from({ length: 101 }, () => current.symbol('main.ts', '\u0001'.repeat(512))),
  );
  const bounded = await current.invoke({ action: 'workspaceSymbols', query: 'found', limit: 100 });
  assert.ok(bounded.items.length > 0 && bounded.items.length < 100);
  assert.equal(bounded.limited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 64000);
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () => undefined);
  assert.deepEqual(
    (await current.invoke({ action: 'workspaceSymbols', query: 'found' })).items,
    [],
  );
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () => ({}));
  await assert.rejects(
    current.invoke({ action: 'workspaceSymbols', query: 'found' }),
    /unsupported result/,
  );
});

test('Stop releases a stalled workspace symbol provider and late results remain retired', async (context) => {
  const current = await setup(context);
  let started!: () => void;
  let release!: (value: unknown) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.commands.set('vscode.executeWorkspaceSymbolProvider', () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = current.invoke({ action: 'workspaceSymbols', query: 'found' });
  await ready;
  current.abort.abort(new Error('Stopped workspace symbols'));
  await assert.rejects(pending, /Stopped workspace symbols/);
  release([current.symbol('main.ts')]);
  await assert.rejects(
    current.invoke({ action: 'workspaceSymbols', query: 'found' }),
    /Stopped workspace symbols/,
  );
});
