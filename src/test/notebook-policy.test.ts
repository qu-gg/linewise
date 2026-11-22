import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookRequest, replaceNotebookCell } from '../notebook-policy.js';

const input = { path: 'example.ipynb', cell: 1, expectedSource: 'old\n', source: 'new\nsecond' };
const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Unexecuted' }, custom: ['retain'] },
  cells: [
    {
      id: 'existing-id',
      cell_type: 'code',
      source: ['old\n'],
      metadata: { tags: ['retain'] },
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['previous output\n'] }],
      execution_count: 7,
    },
    { cell_type: 'markdown', source: 'untouched', metadata: {} },
  ],
}).replace('"nbformat_minor":5', '"nbformat_minor":5,"precise":9007199254740993123456789');

test('notebook source edits preserve metadata, outputs, identities, unrelated cells and numeric literals', () => {
  const after = replaceNotebookCell(notebook, input);
  assert.ok(after.includes('9007199254740993123456789'));
  const previous = JSON.parse(notebook);
  const changed = JSON.parse(after);
  assert.deepEqual(changed.cells[0].source, ['new\n', 'second']);
  changed.cells[0].source = previous.cells[0].source;
  assert.deepEqual(changed, previous);
  assert.equal(replaceNotebookCell(notebook, { ...input, source: input.expectedSource }), notebook);
});

test('notebook edits retain source representation and handle empty text, CRLF and non-code cells', () => {
  const formatted = JSON.stringify(JSON.parse(notebook), null, 2).replaceAll('\n', '\r\n');
  const after = replaceNotebookCell(formatted, { ...input, source: '' });
  assert.deepEqual(JSON.parse(after).cells[0].source, []);
  assert.ok(after.includes('\r\n'));
  const markdown = replaceNotebookCell(notebook, {
    ...input,
    cell: 2,
    expectedSource: 'untouched',
    source: '# Changed\n',
  });
  assert.equal(JSON.parse(markdown).cells[1].source, '# Changed\n');
});

test('notebook schema refuses ambiguous input and notebook transforms fail closed on stale or malformed files', () => {
  for (const invalid of [
    { ...input, extra: true },
    { ...input, path: 'other.json' },
    { ...input, cell: 0 },
    { ...input, cell: 1001 },
    { ...input, source: '\0' },
    { ...input, source: 'a'.repeat(524_289) },
  ])
    assert.equal(notebookRequest.safeParse(invalid).success, false);
  assert.throws(
    () => replaceNotebookCell(notebook, { ...input, expectedSource: 'stale' }),
    /stale/,
  );
  for (const invalid of [
    '',
    '{}',
    '[]',
    notebook + '{}',
    notebook.replace('"nbformat":4', '"nbformat":3'),
    notebook.replace('"nbformat":4', '"nbformat":4,"nbformat":4'),
    notebook.replace('"old\\n"', '1'),
    notebook.replace('"code"', '"custom"'),
    notebook.replace('"nbformat":4', '/* comment */"nbformat":4'),
    notebook.replace('"nbformat":4', '"nbformat":4,'),
    'a'.repeat(1_048_577),
  ])
    assert.throws(() => replaceNotebookCell(invalid, input));
  assert.throws(() => replaceNotebookCell(notebook, { ...input, cell: 3 }), /does not exist/);
  const deep = '{"nbformat":4,"metadata":' + '['.repeat(65) + '0' + ']'.repeat(65) + ',"cells":[]}';
  assert.throws(() => replaceNotebookCell(deep, input), /structural limits/);
});

test('notebook cell count, AST size and escaped postimage size remain bounded', () => {
  const cells = Array.from({ length: 1001 }, () => ({ cell_type: 'code', source: ['old\n'] }));
  assert.throws(
    () => replaceNotebookCell(JSON.stringify({ nbformat: 4, cells }), input),
    /1000 cells/,
  );
  assert.throws(
    () =>
      replaceNotebookCell(
        JSON.stringify({ nbformat: 4, cells: [], metadata: Array(100_001).fill(0) }),
        input,
      ),
    /structural limits/,
  );
  assert.throws(
    () => replaceNotebookCell(notebook, { ...input, source: '"'.repeat(524_288) }),
    /1 MiB/,
  );
});
