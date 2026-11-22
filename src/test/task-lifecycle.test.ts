import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { taskRequest } from '../task-policy.js';
import { runTaskGraph, taskGraphLayers } from '../task-graph.js';
import { z } from 'zod';
import { TerminalManager } from '../terminal.js';
import {
  fixture,
  reset,
  tasks,
  Task,
  Uri,
  ProcessExecution,
  CustomExecution,
} from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { executeWorkspaceTask } = await import('../host-tasks.js');

test('explicit null readiness means foreground without permitting invented final readiness', () => {
  const input = taskRequest.parse({
    name: 'final',
    source: 'fixture',
    graph: [
      {
        id: 'watch',
        name: 'watch',
        source: 'fixture',
        dependsOn: [],
        readiness: { line: 'READY' },
      },
      { id: 'final', name: 'final', source: 'fixture', dependsOn: ['watch'], readiness: null },
    ],
  });
  assert.deepEqual(
    taskGraphLayers(input).map((layer) => layer.map((entry) => entry.id)),
    [['watch'], ['final']],
  );
  const declared = JSON.parse(JSON.stringify(z.toJSONSchema(taskRequest))).properties.graph.items
    .properties.readiness;
  assert.ok(declared.anyOf.some((entry: { type?: string }) => entry.type === 'null'));
  input.graph![1]!.readiness = { line: '...' };
  assert.throws(() => taskGraphLayers(input), /final root must be foreground/);
  input.graph![1]!.readiness = { line: 'READY' };
  assert.throws(() => taskGraphLayers(input), /final root must be foreground/);
});

function graph(names: string[]) {
  return taskRequest.parse({
    name: 'final',
    source: 'fixture',
    graph: [
      ...names.map((name) => ({
        id: name,
        name,
        source: 'fixture',
        readiness: { line: 'READY' },
        dependsOn: [],
      })),
      { id: 'final', name: 'final', source: 'fixture', dependsOn: names },
    ],
  });
}

const output = { output: 'READY\n', truncated: false, exitStatus: { exitCode: 0 } };

test('Stop during native graph startup terminates the late execution and refuses its callback', async (context) => {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-task-startup-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd,
    signal: abort.signal,
    approve: async () => true,
  });
  const scope = { sessionId: 'owner', cwd, privateRoot, signal: abort.signal, valid: () => true };
  fixture.tasks = [
    new Task(
      { type: 'fixture' },
      fixture.roots[0],
      'final',
      'fixture',
      new ProcessExecution(
        process.execPath,
        ['-e', 'require("node:fs").writeFileSync("late.txt","bad");'],
        { env: { ELECTRON_RUN_AS_NODE: '1' } },
      ),
    ),
  ];
  const original = tasks.executeTask;
  let shown!: (task: Task) => void;
  const visible = new Promise<Task>((resolve) => {
    shown = resolve;
  });
  let release!: (run: Awaited<ReturnType<typeof tasks.executeTask>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof tasks.executeTask>>>((resolve) => {
    release = resolve;
  });
  tasks.executeTask = async (task) => {
    shown(task);
    return pending;
  };
  context.after(async () => {
    tasks.executeTask = original;
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const running = executeWorkspaceTask(graph([]), scope, manager);
  const rejected = assert.rejects(running, /Stopped native startup/);
  const task = await visible;
  abort.abort(new Error('Stopped native startup'));
  await rejected;
  let terminated!: () => void;
  const finished = new Promise<void>((resolve) => {
    terminated = resolve;
  });
  const late = {
    task,
    terminal: { open() {}, close() {}, onDidWrite() {}, onDidClose() {} },
    output: '',
    exitCode: undefined as number | undefined,
    terminations: 0,
    terminate() {
      late.terminations++;
      terminated();
    },
  };
  release(late);
  await finished;
  assert.equal(late.terminations, 1);
  assert.ok(task.execution instanceof CustomExecution);
  await assert.rejects(task.execution.callback(task.definition), /Stopped native startup/);
  await assert.rejects(readFile(path.join(cwd, 'late.txt')), { code: 'ENOENT' });
  assert.throws(() => manager.choices(), /cancelled or disposed/);
});

test('graph cleanup attempts every held worker and refuses success after a cleanup fault', async () => {
  const cleaned: string[] = [];
  let finish!: (value: typeof output) => void;
  const completion = new Promise<typeof output>((resolve) => {
    finish = resolve;
  });
  await assert.rejects(
    runTaskGraph(
      graph(['first', 'second']),
      async (node) => {
        if (node.id === 'final') return output;
        return {
          snapshot: { output: 'READY\n', truncated: false },
          completion,
          dispose: async () => {
            cleaned.push(node.id);
            if (node.id === 'first') throw new Error('Expected cleanup fault');
            finish(output);
          },
        };
      },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, /Expected cleanup fault/);
      return true;
    },
  );
  assert.deepEqual(cleaned.sort(), ['first', 'second']);
});

test('a ready prerequisite exiting successfully before graph completion prevents its dependent', async () => {
  let dependentStarts = 0;
  let cleaned = false;
  const result = await runTaskGraph(
    graph(['watch']),
    async (node) => {
      if (node.id === 'final') {
        dependentStarts++;
        return output;
      }
      return {
        snapshot: { output: 'READY\n', truncated: false },
        completion: Promise.resolve(output),
        dispose: async () => {
          cleaned = true;
        },
      };
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0]!.status, 'failed');
  assert.equal(result.results[0]!.exitStatus!.exitCode, 0);
  assert.equal(result.results[1]!.status, 'not-started');
  assert.equal(dependentStarts, 0);
  assert.equal(cleaned, true);
});
