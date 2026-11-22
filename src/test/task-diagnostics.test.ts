import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../terminal.js';
import { taskRequest } from '../task-policy.js';
import { fixture, reset, Uri, Task, ProcessExecution, Document } from './vscode-fixture.js';
import { taskDiagnosticCollections } from './task-fixture.js';
import { taskDiagnosticRows, taskDiagnosticOffset } from '../task-diagnostics.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { executeWorkspaceTask } = await import('../host-tasks.js');

const row = { path: 'source file.ts', line: 2, column: 3, message: 'expected 14\nreceived 21' };

async function diagnosticTask(context: TestContext) {
  reset();
  taskDiagnosticCollections.length = 0;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-task-diagnostics-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  await writeFile(path.join(cwd, row.path), 'first\n  value\n');
  const document = new Document(Uri.file(path.join(cwd, row.path)), 'first\n  value\n');
  fixture.documents.push(document);
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  fixture.configuration.set('task.saveBeforeRun', 'never');
  const abort = new AbortController();
  const scope = { sessionId: 'owner', cwd, privateRoot, signal: abort.signal, valid: () => true };
  const manager = new TerminalManager({ ...scope, approve: async () => true });
  const run = async (rows: unknown[]) => {
    const output = rows.map((value) => JSON.stringify(value)).join('\n') + '\n';
    fixture.tasks = [
      new Task(
        { type: 'fixture' },
        fixture.roots[0],
        'check',
        'fixture',
        new ProcessExecution(
          process.execPath,
          ['-e', `process.stdout.write(${JSON.stringify(output)});process.exitCode=7;`],
          { env: { ELECTRON_RUN_AS_NODE: '1' } },
        ),
      ),
    ];
    return JSON.parse(
      await executeWorkspaceTask(
        taskRequest.parse({ name: 'check', source: 'fixture' }),
        scope,
        manager,
      ),
    );
  };
  context.after(async () => {
    abort.abort();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, document, abort, run };
}

test('task diagnostics publish current in-root locations, preserve dirty source and retire with their prompt', async (context) => {
  const current = await diagnosticTask(context);
  const result = await current.run([
    row,
    { ...row, severity: 'warning' },
    { ...row, path: 'private/hidden.ts' },
    { ...row, path: '/tmp/outside.ts' },
    { ...row, line: 999 },
  ]);
  assert.equal(result.diagnostics.items.length, 2);
  assert.equal(result.diagnostics.ignored, 3);
  assert.equal(taskDiagnosticCollections.length, 1);
  const collection = taskDiagnosticCollections[0]!;
  assert.equal(collection.entries.length, 1);
  assert.equal(collection.entries[0]![1][0]!.source, 'OMP Task');
  assert.equal(collection.entries[0]![1][1]!.severity, 1);
  assert.equal(current.document.isDirty, true);
  assert.equal(current.document.getText(), 'first\n  value\n');
  await current.run([row]);
  assert.equal(taskDiagnosticCollections.length, 1);
  assert.equal(collection.entries[0]![1].length, 1);
  current.abort.abort(new Error('Stopped diagnostics'));
  assert.equal(collection.disposed, true);
  assert.equal(collection.entries.length, 0);
});

test('changed and oversized diagnostic sources are rejected without navigation authority', async (context) => {
  const current = await diagnosticTask(context);
  const positionAt = current.document.positionAt.bind(current.document);
  current.document.positionAt = (offset) => {
    current.document.version++;
    return positionAt(offset);
  };
  assert.equal((await current.run([row])).diagnostics.items.length, 0);
  current.document.positionAt = positionAt;
  await writeFile(path.join(current.cwd, row.path), 'x'.repeat(1048577));
  assert.equal((await current.run([row])).diagnostics.items.length, 0);
  assert.equal(taskDiagnosticCollections.length, 0);
});

test('task diagnostics require strict complete JSON lines and preserve multiline messages', () => {
  const valid = JSON.stringify(row);
  const result = taskDiagnosticRows([
    {
      output: `BOOT\n${valid}\n${JSON.stringify({ ...row, command: 'injected' })}\n{malformed}\n${valid}`,
      truncated: false,
    },
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.message, row.message);
  assert.equal(result.items[0]!.severity, 'error');
  assert.equal(result.ignored, 2);
  assert.equal(taskDiagnosticRows([{ output: `${valid}\n`, truncated: true }]).items.length, 0);
  assert.equal(
    taskDiagnosticRows([{ output: `fragment\n${valid}\n`, truncated: true }]).items.length,
    1,
  );
});

test('diagnostic count, inspection, bytes and unsafe locations remain bounded', () => {
  const output = Array(40).fill(JSON.stringify(row)).join('\n') + '\n';
  const result = taskDiagnosticRows([{ output }]);
  assert.equal(result.items.length, 32);
  assert.equal(result.limited, true);
  assert.equal(
    taskDiagnosticRows([{ output: `${'ordinary\n'.repeat(257)}${JSON.stringify(row)}\n` }]).items
      .length,
    0,
  );
  assert.throws(() => taskDiagnosticRows([{ output: 'x'.repeat(65537) }]), /64 KiB/);
  for (const invalid of [
    { ...row, line: 0 },
    { ...row, column: 0 },
    { ...row, path: 'https://outside/file.ts' },
    { ...row, message: '\u001bhidden' },
  ])
    assert.equal(taskDiagnosticRows([{ output: `${JSON.stringify(invalid)}\n` }]).items.length, 0);
});

test('diagnostic positions are exact UTF-16 offsets in current LF and CRLF source', () => {
  assert.equal(taskDiagnosticOffset('first\r\n  value\r\n', row), 9);
  assert.equal(taskDiagnosticOffset('first\n  value\n', row), 8);
  for (const location of [
    { line: 4, column: 1 },
    { line: 2, column: 50 },
  ])
    assert.throws(() => taskDiagnosticOffset('first\nvalue', location), /outside/);
  assert.throws(() => taskDiagnosticOffset('\0', row), /unavailable/);
  assert.throws(() => taskDiagnosticOffset('x'.repeat(1048577), row), /unavailable/);
});
