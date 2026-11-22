import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, reset, seedFile, Uri, Document } from './vscode-fixture.js';
import { editorRequest } from '../editor-policy.js';
import { LexicalIndex, type IndexedSource } from '../search-index.js';
import { ProjectIgnores } from '../search-ignore.js';
import { SemanticIndex } from '../semantic-index.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { inspectEditor } = await import('../host-inspect.js');

const signal = new AbortController().signal;
const source = (text: string, name = 'source.ts'): IndexedSource => ({
  path: name,
  text,
  fingerprint: 'saved-version-1',
});

test('frozen local LSA relevance meets top-five gates without relabeling lexical or symbol controls', async () => {
  const frozen = JSON.parse(
    await readFile(new URL('../../src/test/semantic-relevance.json', import.meta.url), 'utf8'),
  ) as {
    sources: Record<string, string>;
    queries: { query: string; expected: string; nonliteral: boolean; symbol: string }[];
    budgets: { topFiveMinimum: number; nonliteralMinimum: number };
  };
  const sources = Object.entries(frozen.sources).map(([name, text]) => source(text, name));
  const index = new SemanticIndex();
  const started = performance.now();
  const captured = await index.prepare('/owned', sources, signal);
  assert.ok(performance.now() - started <= 10000);
  const lexical = new LexicalIndex();
  lexical.update('/owned', sources, signal);
  let matched = 0;
  let nonliteral = 0;
  for (const entry of frozen.queries) {
    const result = captured.search(entry.query, 5);
    const found = result.items.some((item) => item.path === entry.expected);
    matched += Number(found);
    nonliteral += Number(found && entry.nonliteral);
    assert.equal(result.backend, 'local-lsa-v1');
    assert.equal(result.inferenceRequests, 0);
    assert.ok(result.derivedBytes <= 16_777_216);
    assert.ok(frozen.sources[entry.expected]!.includes(entry.symbol));
    if (entry.nonliteral) assert.equal(lexical.search(entry.query, false, 100).items.length, 0);
  }
  assert.ok(matched >= frozen.budgets.topFiveMinimum, `Frozen top-five relevance: ${matched}/20`);
  assert.ok(
    nonliteral >= frozen.budgets.nonliteralMinimum,
    `Frozen nonliteral relevance: ${nonliteral}/10`,
  );
});

test('semantic snapshots retain source ownership and bounds across refresh, deletion, error and cancellation', async () => {
  const index = new SemanticIndex();
  const original = source('export const invoiceTotal = price * quantity;');
  const first = await index.prepare('/owned', [original], signal);
  original.text = 'export const cancelledQueue = [];';
  const next = await index.prepare('/owned', [original], signal);
  assert.equal(first.search('invoice price', 5).items.length, 1);
  assert.equal(next.search('invoice price', 5).items.length, 0);
  assert.equal(await index.prepare('/owned', [original], signal), next);
  assert.equal((await index.prepare('/different', [], signal)).search('price', 5).items.length, 0);
  const partial = await index.prepare(
    '/owned',
    Array.from({ length: 65 }, (_, number) => source('bounded value', `${number}.ts`)),
    signal,
  );
  assert.equal(partial.search('value', 100).limited, true);
  for (const invalid of [
    source('outside', '../outside.ts'),
    source('binary\0'),
    source('x'.repeat(1_048_577)),
  ]) {
    if (invalid.text.length > 1_048_576) {
      assert.equal((await index.prepare('/owned', [invalid], signal)).search('x', 5).limited, true);
    } else await assert.rejects(index.prepare('/owned', [invalid], signal));
  }
  const cancelled = new AbortController();
  cancelled.abort(new Error('Stopped semantic capture'));
  await assert.rejects(index.prepare('/owned', [], cancelled.signal), /Stopped semantic capture/);
  await assert.rejects(
    new SemanticIndex(() => {
      throw new Error('Backend failed');
    }).prepare('/owned', [original], signal),
    /Backend failed/,
  );
  for (const query of ['', 'x'.repeat(201)]) assert.throws(() => next.search(query, 1));
  for (const limit of [0, 101, 1.5]) assert.throws(() => next.search('queue', limit));
});

test('semantic generations are locale-independent and interrupted builds cannot replace a snapshot', async () => {
  const index = new SemanticIndex();
  const sources = [source('shared value', '\u00e9.ts'), source('shared value', 'e\u0301.ts')];
  const first = await index.prepare('/owned', sources, signal);
  assert.equal(await index.prepare('/owned', [...sources].reverse(), signal), first);
  const abort = new AbortController();
  let cancelBuild = false;
  const interruptible = new SemanticIndex((rows) => {
    if (cancelBuild) abort.abort(new Error('Stopped during semantic decomposition'));
    return rows[0]!.map(() => [1]);
  });
  const previous = await interruptible.prepare('/owned', [source('original')], signal);
  cancelBuild = true;
  await assert.rejects(
    interruptible.prepare('/owned', [source('replacement')], abort.signal),
    /Stopped during semantic decomposition/,
  );
  assert.equal(await interruptible.prepare('/owned', [source('original')], signal), previous);
  assert.equal(previous.search('original', 1).items.length, 1);
});

async function hostFixture(context: TestContext, files: Record<string, string>) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-index-host-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  context.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
    seedFile(target, text);
    const document = new Document(Uri.file(target), text);
    document.isDirty = false;
    fixture.documents.push(document);
  }
  fixture.roots = [{ name: 'indexed', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const invoke = async (query: string) =>
    JSON.parse(
      await inspectEditor(editorRequest.parse({ action: 'search', query }), {
        cwd,
        privateRoot,
        signal: abort.signal,
      }),
    );
  const semantic = async (query: string, backend = 'local-lsa-v1') =>
    JSON.parse(
      await inspectEditor(editorRequest.parse({ action: 'semanticSearch', query, backend }), {
        cwd,
        privateRoot,
        signal: abort.signal,
      }),
    );
  return { cwd, invoke, semantic, abort };
}

test('host semantic queries require an available explicit backend and share privacy, ignores and dirty overlays', async (context) => {
  const current = await hostFixture(context, {
    'source.ts': 'export const invoiceTotal = quantity * price;',
    'private/secret.ts': 'PRIVATE_SEMANTIC_MARKER',
    'ignored.ts': 'PRIVATE_SEMANTIC_MARKER',
    '.ignore': 'ignored.ts\n',
  });
  assert.equal((await current.semantic('quantity', 'missing')).unavailable, true);
  const first = await current.semantic('quantity price');
  assert.equal(first.items[0].path, 'source.ts');
  assert.equal(first.backend, 'local-lsa-v1');
  assert.equal(first.stale, false);
  assert.equal((await current.semantic('PRIVATE_SEMANTIC_MARKER')).items.length, 0);
  const document = fixture.documents.find((item) => item.uri.fsPath.endsWith('/source.ts'))!;
  document.isDirty = true;
  document.getText = () => 'export const cancelledQueue = [];';
  assert.equal((await current.semantic('quantity')).items.length, 0);
  const overlay = await current.semantic('cancelled queue');
  assert.equal(overlay.overlayFiles, 1);
  assert.equal(overlay.items[0].path, 'source.ts');
  assert.equal(
    await readFile(path.join(current.cwd, 'source.ts'), 'utf8'),
    'export const invoiceTotal = quantity * price;',
  );
  current.abort.abort(new Error('Stopped semantic query'));
  await assert.rejects(current.semantic('queue'), /Stopped semantic query/);
});

test('semantic host rejects post-build source and ignore races and reports backend errors without lexical fallback', async (context) => {
  const current = await hostFixture(context, { 'source.ts': 'export const invoiceQuantity = 7;' });
  const prepare = SemanticIndex.prototype.prepare;
  let mutate = async () => {
    await writeFile(path.join(current.cwd, 'source.ts'), 'export const replacedQuantity = 9;');
  };
  context.mock.method(
    SemanticIndex.prototype,
    'prepare',
    async function (this: SemanticIndex, ...args: Parameters<SemanticIndex['prepare']>) {
      const snapshot = await prepare.apply(this, args);
      await mutate();
      return snapshot;
    },
  );
  const stale = await current.semantic('invoice quantity');
  assert.equal(stale.stale, true);
  assert.equal(stale.limited, true);
  assert.deepEqual(stale.items, []);
  mutate = async () => {
    await writeFile(path.join(current.cwd, '.ignore'), 'source.ts\n');
  };
  const rules = await current.semantic('replaced quantity');
  assert.equal(rules.stale, true);
  assert.deepEqual(rules.items, []);
  context.mock.restoreAll();
  context.mock.method(SemanticIndex.prototype, 'prepare', async () => {
    throw new Error('Owned backend failure');
  });
  const failed = await current.semantic('replaced quantity');
  assert.equal(failed.unavailable, true);
  assert.equal(failed.reason, 'backend-error');
  assert.deepEqual(failed.items, []);
});

test('host index respects project ignores, workspace exclusions and hard privacy across rule changes', async (context) => {
  const current = await hostFixture(context, {
    'root.ts': 'FROZEN_RESULT',
    'skip.ts': 'FROZEN_RESULT',
    'nested/keep.ts': 'FROZEN_RESULT',
    'nested/skip.ts': 'FROZEN_RESULT',
    'blocked/keep.ts': 'FROZEN_RESULT',
    'private/secret.ts': 'FROZEN_RESULT',
    'reports/hidden.ts': 'FROZEN_RESULT',
    '.gitignore': '*.ts\nblocked/\n',
    '.ignore': '!root.ts\n',
    'nested/.gitignore': '!keep.ts\n',
    'blocked/.ignore': '!keep.ts\n',
  });
  assert.deepEqual(
    (await current.invoke('FROZEN_RESULT')).items.map((item: { path: string }) => item.path),
    ['nested/keep.ts', 'root.ts'],
  );
  fixture.configuration.set('files.exclude', { '**/nested': true });
  assert.deepEqual(
    (await current.invoke('FROZEN_RESULT')).items.map((item: { path: string }) => item.path),
    ['root.ts'],
  );
  await writeFile(path.join(current.cwd, '.ignore'), '!skip.ts\n');
  seedFile(path.join(current.cwd, '.ignore'), '!skip.ts\n');
  assert.deepEqual(
    (await current.invoke('FROZEN_RESULT')).items.map((item: { path: string }) => item.path),
    ['skip.ts'],
  );
});

test('saved disk changes are fresh even while the clean VS Code document still has old text', async (context) => {
  const current = await hostFixture(context, { 'source.ts': 'OLD_CAPTURE' });
  assert.equal((await current.invoke('OLD_CAPTURE')).items.length, 1);
  await writeFile(path.join(current.cwd, 'source.ts'), 'NEW_CAPTURE');
  seedFile(path.join(current.cwd, 'source.ts'), 'NEW_CAPTURE');
  assert.equal(fixture.documents[0]!.getText(), 'OLD_CAPTURE');
  const updated = await current.invoke('NEW_CAPTURE');
  assert.equal(updated.items.length, 1);
  assert.equal(updated.stale, false);
  assert.equal((await current.invoke('OLD_CAPTURE')).items.length, 0);
});

test('host index refuses oversized and binary project rules rather than ignoring them', async (context) => {
  for (const text of ['x'.repeat(65537), 'blocked\0']) {
    const current = await hostFixture(context, { 'source.ts': 'FROZEN_RESULT', '.ignore': text });
    await assert.rejects(current.invoke('FROZEN_RESULT'), /stable regular text limits/);
  }
});

test('project ignores apply ordered root/nested negation without reopening ignored parents', async () => {
  const rules = new Map([
    ['.gitignore', '*.ts\r\nblocked/\r\n'],
    ['.ignore', '!root.ts\n'],
    ['nested/.gitignore', '!keep.ts\n'],
    ['blocked/.ignore', '!keep.ts\n'],
  ]);
  const inspected: string[] = [];
  const policy = new ProjectIgnores(async (relative) => {
    inspected.push(relative);
    return rules.get(relative);
  }, signal);
  assert.equal(await policy.accepts('root.ts'), true);
  assert.equal(await policy.accepts('skip.ts'), false);
  assert.equal(await policy.accepts('nested/keep.ts'), true);
  assert.equal(await policy.accepts('nested/skip.ts'), false);
  assert.equal(await policy.accepts('blocked/keep.ts'), false);
  assert.equal(inspected.includes('blocked/.ignore'), false);
  assert.deepEqual(inspected.slice(0, 4), [
    '.gitignore',
    '.ignore',
    'nested/.gitignore',
    'nested/.ignore',
  ]);
  assert.equal(await policy.fresh(), true);
  rules.set('.ignore', '!skip.ts\n');
  assert.equal(await policy.fresh(), false);
});

test('project ignore reads fail closed on outside paths, excess text and cancellation', async () => {
  const policy = new ProjectIgnores(async () => 'x'.repeat(65537), signal);
  await assert.rejects(policy.accepts('source.ts'), /bounded text/);
  await assert.rejects(policy.accepts('../outside.ts'), /root scope/);
  const refused = new ProjectIgnores(async () => {
    throw new Error('Private rule refused');
  }, signal);
  await assert.rejects(refused.accepts('source.ts'), /Private rule refused/);
  const abort = new AbortController();
  abort.abort(new Error('Stopped ignore discovery'));
  const cancelled = new ProjectIgnores(async () => undefined, abort.signal);
  await assert.rejects(cancelled.accepts('source.ts'), /Stopped ignore discovery/);
});

test('lexical cache preserves literal, Unicode and CRLF ranges with immutable root-owned generations', () => {
  const index = new LexicalIndex();
  const original = source('A+B\r\nCaf\u00e9 RATE rate\n');
  assert.equal(index.update('/owned', [original], signal), 1);
  assert.equal(index.update('/owned', [original], signal), 1);
  assert.equal(index.search('A+B', true, 100).items.length, 1);
  const result = index.search('caf\u00e9', false, 100);
  assert.equal(result.items[0]!.line, 2);
  assert.equal(result.items[0]!.column, 1);
  assert.equal(result.items[0]!.endColumn, 5);
  assert.equal(index.search('rate', true, 100).items.length, 1);
  assert.equal(index.search('rate', false, 1).limited, true);
  original.text = 'changed after capture';
  assert.equal(index.search('A+B', true, 100).items.length, 1);
  assert.equal(index.update('/owned', [original], signal), 2);
  assert.equal(index.search('A+B', true, 100).items.length, 0);
  assert.equal(index.update('/different-root', [original], signal), 3);
  assert.notEqual(index.search('changed', true, 100).rootHash, result.rootHash);
  assert.equal(index.update('/different-root', [], signal), 4);
  assert.equal(index.search('changed', true, 100).items.length, 0);
});

test('lexical cache generation and hit order survive discovery permutations but not changed fingerprints', () => {
  const index = new LexicalIndex();
  const first = source('shared', 'first.ts');
  const second = source('shared', 'second.ts');
  assert.equal(index.update('/owned', [second, first], signal), 1);
  const initial = index.search('shared', true, 100);
  assert.equal(index.update('/owned', [first, second], signal), 1);
  assert.deepEqual(index.search('shared', true, 100), initial);
  assert.deepEqual(
    initial.items.map((item) => item.path),
    ['first.ts', 'second.ts'],
  );
  assert.equal(
    index.update('/owned', [{ ...first, fingerprint: 'saved-version-2' }, second], signal),
    2,
  );
});

test('lexical cache refuses oversized, binary, duplicate or outside sources and cancelled commits', () => {
  const index = new LexicalIndex();
  index.update('/owned', [source('accepted')], signal);
  for (const sources of [
    [source('outside', '../outside.ts')],
    [source('outside', '/outside.ts')],
    [source('binary\0')],
    [source('large'.repeat(262145))],
    [source('duplicate'), source('duplicate')],
    Array.from({ length: 257 }, (_, count) => source('file', `${count}.ts`)),
    Array.from({ length: 5 }, (_, count) => source('x'.repeat(1_048_576), `${count}.ts`)),
  ])
    assert.throws(() => index.update('/owned', sources, signal));
  const abort = new AbortController();
  abort.abort(new Error('Stopped index build'));
  assert.throws(() => index.update('/owned', [], abort.signal), /Stopped index build/);
  assert.equal(index.search('accepted', true, 100).generation, 1);
  assert.doesNotThrow(() => index.search('x'.repeat(512), true, 1));
  for (const query of ['', 'x'.repeat(513)]) assert.throws(() => index.search(query, true, 1));
  for (const limit of [0, 101, 1.5]) assert.throws(() => index.search('accepted', true, limit));
});
