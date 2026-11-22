import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../terminal.js';
import type { TerminalOptions } from '../terminal.js';
import { taskRequest } from '../task-policy.js';
import { taskGraphLayers, runTaskGraph } from '../task-graph.js';
import { awaitTaskReadiness, matchesTaskReadiness } from '../task-readiness.js';
import { fixture, reset, Uri, Task, ProcessExecution } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { executeWorkspaceTask, workspaceTaskMetadata } = await import('../host-tasks.js');

async function setup(context: TestContext, approve: TerminalOptions['approve']) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-task-graph-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  const abort = new AbortController();
  const manager = new TerminalManager({ sessionId: 'owner', cwd, signal: abort.signal, approve });
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const scope = { sessionId: 'owner', cwd, privateRoot, signal: abort.signal, valid: () => true };
  const command = (name: string) => ({
    sessionId: 'owner',
    command: process.execPath,
    args: ['-e', `require("node:fs").writeFileSync("${name}.txt","started");`],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  });
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const task = (name: string, body: string) =>
    new Task(
      { type: 'fixture' },
      fixture.roots[0],
      name,
      'fixture',
      new ProcessExecution(process.execPath, ['-e', body], { env: { ELECTRON_RUN_AS_NODE: '1' } }),
    );
  const graph = async (
    nodes: Array<{ id: string; name: string; dependsOn: string[]; readiness?: { line: string } }>,
  ) =>
    JSON.parse(
      await executeWorkspaceTask(
        taskRequest.parse({
          name: nodes.at(-1)!.name,
          source: 'fixture',
          graph: nodes.map((node) => ({ ...node, source: 'fixture' })),
        }),
        scope,
        manager,
      ),
    );
  return { cwd, abort, manager, command, task, graph };
}

const node = (name: string, dependsOn: string[] = []) => ({ id: name, name, dependsOn });

test('exit before graph readiness retains the actual failure and never launches a dependent', async (context) => {
  const current = await setup(context, async () => true);
  const background = current.task('watch', 'process.stdout.write("BOOT\\n");process.exitCode=8;');
  background.isBackground = true;
  fixture.tasks = [
    background,
    current.task('final', 'require("node:fs").writeFileSync("final.txt","bad");'),
  ];
  const result = await current.graph([
    { ...node('watch'), readiness: { line: 'READY' } },
    node('final', ['watch']),
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0].exitStatus.exitCode, 8);
  assert.equal(result.results[0].readiness, 'failed');
  assert.equal(result.results[0].output, 'BOOT\n');
  assert.equal(result.results[1].status, 'not-started');
  await assert.rejects(readFile(path.join(current.cwd, 'final.txt')), { code: 'ENOENT' });
});

test(
  'Stop before declared graph readiness cleans the worker without a dependent or late restart',
  { timeout: 4000 },
  async (context) => {
    const current = await setup(context, async () => true);
    const watcher = watch(current.cwd);
    context.after(() => watcher.close());
    const started = new Promise<void>((resolve) => {
      watcher.on('change', (_event, name) => {
        if (name === 'watch.txt') resolve();
      });
    });
    const background = current.task(
      'watch',
      'const fs=require("node:fs");fs.writeFileSync("watch.tmp",String(process.pid));fs.renameSync("watch.tmp","watch.txt");process.stdout.write("BOOT\\n");setInterval(()=>{},1000);',
    );
    background.isBackground = true;
    fixture.tasks = [
      background,
      current.task('final', 'require("node:fs").writeFileSync("final.txt","bad");'),
    ];
    const running = current.graph([
      { ...node('watch'), readiness: { line: 'READY' } },
      node('final', ['watch']),
    ]);
    const rejected = assert.rejects(running, /Stopped graph readiness/);
    await started;
    current.abort.abort(new Error('Stopped graph readiness'));
    await rejected;
    const pid = Number(await readFile(path.join(current.cwd, 'watch.txt'), 'utf8'));
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(readFile(path.join(current.cwd, 'final.txt')), { code: 'ENOENT' });
  },
);

test('native-owned background prerequisite reaches readiness before the final task and is terminated afterwards', async (context) => {
  const current = await setup(context, async () => true);
  const watch = current.task(
    'watch',
    'require("node:fs").writeFileSync("watch.txt",String(process.pid));process.stdout.write("READY\\n");setInterval(()=>{},1000);',
  );
  watch.isBackground = true;
  fixture.tasks = [
    watch,
    current.task(
      'final',
      'const files=require("node:fs");process.kill(Number(files.readFileSync("watch.txt","utf8")),0);files.writeFileSync("final.txt","passed");',
    ),
  ];
  const result = await current.graph([
    { ...node('watch'), readiness: { line: 'READY' } },
    node('final', ['watch']),
  ]);
  assert.equal(result.status, 'passed');
  assert.equal(result.results[0].readiness, 'ready');
  assert.equal(result.results[0].status, 'exited');
  assert.equal(result.results[0].cleanup, 'graph-complete');
  assert.equal(await readFile(path.join(current.cwd, 'final.txt'), 'utf8'), 'passed');
  const pid = Number(await readFile(path.join(current.cwd, 'watch.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(current.manager.choices().length, 0);
});

test('background graph prerequisites stay owned until final completion and are then cleaned', async () => {
  const input = taskRequest.parse({
    name: 'final',
    source: 'fixture',
    graph: [
      { ...node('watch'), source: 'fixture', readiness: { line: 'READY' } },
      { ...node('final', ['watch']), source: 'fixture' },
    ],
  });
  let finish!: (value: {
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number };
  }) => void;
  const completion = new Promise<{
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number };
  }>((resolve) => {
    finish = resolve;
  });
  let disposed = false;
  const result = await runTaskGraph(
    input,
    async (current) => {
      if (current.id === 'watch')
        return {
          snapshot: { output: 'READY\n', truncated: false },
          completion,
          dispose: async () => {
            disposed = true;
            finish({ output: 'READY\n', truncated: false, exitStatus: { exitCode: 0 } });
          },
        };
      assert.equal(disposed, false);
      return { output: 'FINAL', truncated: false, exitStatus: { exitCode: 0 } };
    },
    new AbortController().signal,
  );
  assert.equal(disposed, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.results[0]!.readiness, 'ready');
  assert.equal(result.results[0]!.status, 'exited');
  assert.equal(result.results[0]!.cleanup, 'graph-complete');
  assert.equal(result.results[1]!.status, 'passed');
  assert.throws(
    () => taskGraphLayers(taskRequest.parse({ ...input, name: 'watch', graph: [input.graph![0]] })),
    /foreground/,
  );
});

test('ready background failure cancels the active dependent and retains its actual exit', async () => {
  const input = taskRequest.parse({
    name: 'final',
    source: 'fixture',
    graph: [
      { ...node('watch'), source: 'fixture', readiness: { line: 'READY' } },
      { ...node('final', ['watch']), source: 'fixture' },
    ],
  });
  let finish!: (value: {
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number };
  }) => void;
  const completion = new Promise<{
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number };
  }>((resolve) => {
    finish = resolve;
  });
  const result = await runTaskGraph(
    input,
    async (current, signal) => {
      if (current.id === 'watch')
        return {
          snapshot: { output: 'READY\n', truncated: false },
          completion,
          dispose: async () => {},
        };
      finish({ output: 'READY\nFAILED', truncated: false, exitStatus: { exitCode: 7 } });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0]!.exitStatus!.exitCode, 7);
  assert.equal(result.results[0]!.status, 'failed');
  assert.equal(result.results[1]!.status, 'cancelled');
});
test('task identity is owned by the exact root, not a nested workspace folder', async (context) => {
  let approvals = 0;
  const current = await setup(context, async () => {
    approvals++;
    return true;
  });
  const nested = path.join(current.cwd, 'nested');
  await mkdir(nested);
  fixture.roots.push({ name: 'nested', uri: Uri.file(nested), index: 1 });
  const foreign = current.task('final', 'process.stdout.write("foreign");');
  foreign.scope = fixture.roots[1];
  fixture.tasks = [foreign];
  await assert.rejects(current.graph([node('final')]), /unavailable/);
  assert.deepEqual(
    await workspaceTaskMetadata(
      {
        cwd: current.cwd,
        privateRoot: path.join(current.cwd, 'private'),
        signal: current.abort.signal,
      },
      100,
    ),
    [],
  );
  assert.equal(approvals, 0);
});

test('readiness requires a complete exact owned output line, not start or truncated fragments', () => {
  const snapshot = { output: 'BOOT\nREADY', truncated: false };
  assert.equal(matchesTaskReadiness(snapshot, 'READY'), false);
  assert.equal(matchesTaskReadiness({ ...snapshot, output: 'NOT_READY\n' }, 'READY'), false);
  assert.equal(matchesTaskReadiness({ output: 'READY\n', truncated: true }, 'READY'), false);
  assert.equal(
    matchesTaskReadiness({ output: 'partial\nREADY\r\n', truncated: true }, 'READY'),
    true,
  );
});

test('owned task readiness waits through start output until the declared event', async (context) => {
  const current = await setup(context, async () => true);
  const command = {
    ...current.command('ready'),
    args: [
      '-e',
      'const files=require("node:fs");const watcher=files.watch(".",(_event,name)=>{if(name==="go.txt"){process.stdout.write("READY\\n");watcher.close();}});process.stdout.write("BOOT\\n");setInterval(()=>{},1000);',
    ],
  };
  const request = { sessionId: 'owner', ...(await current.manager.create(command)) };
  assert.match((await current.manager.waitForOutput(request, 1000)).output, /BOOT/);
  let ready = false;
  const waiting = awaitTaskReadiness(current.manager, request, 'READY', current.abort.signal).then(
    (result) => {
      ready = true;
      return result;
    },
  );
  assert.equal(ready, false);
  await writeFile(path.join(current.cwd, 'go.txt'), 'go');
  assert.ok(matchesTaskReadiness(await waiting, 'READY'));
  await current.manager.release(request);
});

test('task exit before readiness and Stop reject waits without accepting late output', async (context) => {
  const current = await setup(context, async () => true);
  const request = {
    sessionId: 'owner',
    ...(await current.manager.create({
      ...current.command('early'),
      args: ['-e', 'process.stdout.write("BOOT\\n");'],
    })),
  };
  await assert.rejects(
    awaitTaskReadiness(current.manager, request, 'READY', current.abort.signal),
    /before declared readiness/,
  );
  await current.manager.release(request);
  const active = {
    sessionId: 'owner',
    ...(await current.manager.create({
      ...current.command('active'),
      args: ['-e', 'process.stdout.write("BOOT\\n");setInterval(()=>{},1000);'],
    })),
  };
  const stopped = new AbortController();
  const pending = awaitTaskReadiness(current.manager, active, 'READY', stopped.signal);
  const rejected = assert.rejects(pending, /Stopped readiness/);
  stopped.abort(new Error('Stopped readiness'));
  await rejected;
  await current.manager.release(active);
});

test('graph policy refuses cycles, missing, duplicate and unrelated nodes before execution', () => {
  for (const nodes of [
    [node('first', ['final']), node('final', ['first'])],
    [node('first'), node('final', ['missing'])],
    [node('final'), node('final')],
    [node('unrelated'), node('final')],
  ])
    assert.throws(
      () =>
        taskGraphLayers(
          taskRequest.parse({
            name: 'final',
            source: 'fixture',
            graph: nodes.map((entry) => ({ ...entry, source: 'fixture' })),
          }),
        ),
      /cycle|missing|duplicate|unrelated/,
    );
  assert.equal(
    taskRequest.safeParse({
      name: 'final',
      source: 'fixture',
      graph: Array(4).fill({ ...node('final'), source: 'fixture' }),
    }).success,
    true,
  );
  assert.equal(
    taskRequest.safeParse({
      name: 'final',
      source: 'fixture',
      graph: Array(5).fill({ ...node('final'), source: 'fixture' }),
    }).success,
    false,
  );
});

test('OMP-owned parallel prerequisites finish before the exact final task starts', async (context) => {
  let approvals = 0;
  const current = await setup(context, async () => {
    approvals++;
    return true;
  });
  fixture.tasks = [
    current.task('first', 'require("node:fs").writeFileSync("first.txt","ready");'),
    current.task('second', 'require("node:fs").writeFileSync("second.txt","ready");'),
    current.task(
      'final',
      'const files=require("node:fs");if(!files.existsSync("first.txt")||!files.existsSync("second.txt"))process.exitCode=9;else files.writeFileSync("final.txt","passed");',
    ),
  ];
  const result = await current.graph([
    node('first'),
    node('second'),
    node('final', ['first', 'second']),
  ]);
  assert.equal(result.graph, 'OMP-owned');
  assert.equal(result.status, 'passed');
  assert.equal(approvals, 3);
  assert.ok(result.results.every((entry: { status: string }) => entry.status === 'passed'));
  assert.equal(await readFile(path.join(current.cwd, 'final.txt'), 'utf8'), 'passed');
});

test('failed graph prerequisite never launches the dependent task', async (context) => {
  const current = await setup(context, async () => true);
  fixture.tasks = [
    current.task('first', 'process.exitCode=7;'),
    current.task('final', 'require("node:fs").writeFileSync("final.txt","bad");'),
  ];
  const result = await current.graph([node('first'), node('final', ['first'])]);
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0].exitStatus.exitCode, 7);
  assert.equal(result.results[1].status, 'not-started');
  await assert.rejects(readFile(path.join(current.cwd, 'final.txt')), { code: 'ENOENT' });
});

test('graph rejects a changed provider definition after consent without a native task launch', async (context) => {
  const current = await setup(context, async () => {
    ((fixture.tasks[0] as Task).definition as { type: string }).type = 'changed';
    return true;
  });
  fixture.tasks = [current.task('final', 'process.stdout.write("unchanged");')];
  await assert.rejects(current.graph([node('final')]), /changed after consent/);
  assert.equal(fixture.taskRuns.length, 0);
});

test('task reservations obtain every command consent before any process can launch', async (context) => {
  let approvals = 0;
  const current = await setup(context, async () => ++approvals < 2);
  await assert.rejects(
    current.manager.reserve([current.command('first'), current.command('second')]),
    /not approved/,
  );
  assert.equal(approvals, 2);
  for (const name of ['first', 'second'])
    await assert.rejects(readFile(path.join(current.cwd, `${name}.txt`)), { code: 'ENOENT' });
  assert.equal(current.manager.choices().length, 0);
});

test('task reservations are one-use, occupy shared capacity and release unused permits', async (context) => {
  const current = await setup(context, async () => true);
  const reservation = await current.manager.reserve([
    current.command('first'),
    current.command('second'),
    current.command('third'),
    current.command('fourth'),
  ]);
  await assert.rejects(current.manager.create(current.command('unrelated')), /Release a terminal/);
  const request = { sessionId: 'owner', ...(await reservation.start(0)) };
  await current.manager.waitForExit(request);
  await assert.rejects(reservation.start(0), /unavailable/);
  await current.manager.release(request);
  reservation.dispose();
  await assert.rejects(reservation.start(1), /unavailable/);
  const next = { sessionId: 'owner', ...(await current.manager.create(current.command('next'))) };
  await current.manager.waitForExit(next);
  await current.manager.release(next);
  assert.equal(await readFile(path.join(current.cwd, 'first.txt'), 'utf8'), 'started');
});

test('reserved tasks revalidate after consent and cannot launch after Stop', async (context) => {
  const current = await setup(context, async () => true);
  const reservation = await current.manager.reserve([current.command('first')]);
  await assert.rejects(
    reservation.start(0, null, async () => {
      throw new Error('Stale graph definition');
    }),
    /Stale graph/,
  );
  reservation.dispose();
  const stopped = await current.manager.reserve([current.command('second')]);
  current.abort.abort(new Error('Stopped graph'));
  await assert.rejects(stopped.start(0), /unavailable|Stopped/);
  for (const name of ['first', 'second'])
    await assert.rejects(readFile(path.join(current.cwd, `${name}.txt`)), { code: 'ENOENT' });
  stopped.dispose();
});
