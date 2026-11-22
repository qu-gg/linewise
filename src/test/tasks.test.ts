import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { taskRequest } from '../task-policy.js';
import { TerminalManager } from '../terminal.js';
import type { TerminalOptions, TerminalCommand } from '../terminal.js';
import { installNativeTask } from '../native-task.js';
import type { NativeEditApi } from '../native-edit.js';
import {
  fixture,
  reset,
  Uri,
  ProcessExecution,
  ShellExecution,
  CustomExecution,
  Task,
  TaskScope,
  tasks,
  Document,
} from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { executeWorkspaceTask, workspaceTaskMetadata } = await import('../host-tasks.js');
const { HostTools } = await import('../host-tools.js');

test('one cancelled command approval cannot launch late or cancel its sibling', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  let pending = true;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const { manager, cwd } = await setup(context, async () => {
    if (!pending) return true;
    shown();
    return new Promise<boolean>((resolve) => {
      allow = resolve;
    });
  });
  const command = (source: string) => ({
    sessionId: 'owner',
    command: process.execPath,
    args: ['-e', source],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  });
  const cancelled = new AbortController();
  const creating = manager.create(
    command('require("node:fs").writeFileSync("late.txt","bad");'),
    null,
    cancelled.signal,
  );
  const rejected = assert.rejects(creating, /Task cancelled/);
  await visible;
  cancelled.abort(new Error('Task cancelled'));
  await rejected;
  allow(true);
  pending = false;
  const request = {
    sessionId: 'owner',
    ...(await manager.create(command('process.stdout.write("sibling");'))),
  };
  await manager.waitForExit(request);
  assert.equal(manager.output(request).output, 'sibling');
  await manager.release(request);
  await assert.rejects(readFile(path.join(cwd, 'late.txt')), { code: 'ENOENT' });
  await assert.rejects(manager.create(command(''), null, cancelled.signal), /Task cancelled/);
});

async function setup(context: TestContext, approve?: TerminalOptions['approve']) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-tasks-'));
  const privateRoot = path.join(cwd, 'private');
  await mkdir(privateRoot);
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const current = { active: true };
  const scope = {
    sessionId: 'owner',
    cwd,
    privateRoot,
    signal: abort.signal,
    valid: () => current.active,
  };
  const approvals: TerminalCommand[] = [];
  const manager = new TerminalManager({
    ...scope,
    approve: async (command, signal) => {
      approvals.push(structuredClone(command));
      return approve ? approve(command, signal) : true;
    },
  });
  const task = (execution: unknown, name = 'check') =>
    new Task({ type: 'fixture' }, fixture.roots[0], name, 'fixture', execution);
  const processTask = (source = 'process.stdout.write("task passed");') =>
    task(
      new ProcessExecution(process.execPath, ['-e', source], {
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
    );
  const invoke = async (input: unknown = { name: 'check', source: 'fixture' }) =>
    JSON.parse(await executeWorkspaceTask(taskRequest.parse(input), scope, manager));
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, privateRoot, abort, scope, current, approvals, manager, task, processTask, invoke };
}

test('read-only task metadata reports capture support and exact duplicate identities', async (context) => {
  const current = await setup(context);
  const background = current.task(new ProcessExecution('/bin/true'), 'watch');
  background.isBackground = true;
  fixture.tasks = [
    current.processTask(),
    background,
    current.task(
      new CustomExecution(async () => {
        throw new Error('Discovery must not execute a provider callback.');
      }),
      'custom',
    ),
  ];
  const metadata = (await workspaceTaskMetadata(current.scope, 100)) as Array<{
    supported: boolean;
    unavailableReason?: string;
  }>;
  assert.equal(metadata[0]!.supported, true);
  assert.equal(metadata[1]!.unavailableReason, 'background-readiness-required');
  assert.equal(metadata[2]!.unavailableReason, 'opaque-execution');
  fixture.tasks = [current.processTask(), current.processTask()];
  const duplicate = (await workspaceTaskMetadata(current.scope, 100)) as typeof metadata;
  assert.ok(duplicate.every((item) => item.unavailableReason === 'ambiguous-identity'));
  assert.equal(current.approvals.length, 0);
  assert.equal(fixture.taskRuns.length, 0);
});

test('task requests select a named source without injecting execution authority', () => {
  for (const timeout of [undefined, null, 1, 120])
    assert.equal(
      taskRequest.safeParse({ name: 'check', source: 'workspace', timeout }).success,
      true,
    );
  for (const input of [
    { name: '', source: 'workspace' },
    { name: 'check', source: '' },
    { name: 'check', source: 'workspace', timeout: 0 },
    { name: 'check', source: 'workspace', timeout: 121 },
    { name: 'check', source: 'workspace', command: 'injected' },
    { name: 'check', source: 'workspace', args: ['injected'] },
    { name: 'check', source: 'workspace', env: { SECRET: 'injected' } },
  ])
    assert.equal(taskRequest.safeParse(input).success, false);
});

test('native owned process tasks return bounded output and structured failing exits', async (context) => {
  const current = await setup(context);
  fixture.tasks = [
    current.processTask(
      'process.stdout.write("out\\n");process.stderr.write("assertion failed");process.exitCode=7;',
    ),
  ];
  const result = await current.invoke();
  assert.equal(result.task.name, 'check');
  assert.equal(result.exitStatus.exitCode, 7);
  assert.equal(result.untrusted, true);
  assert.match(result.output, /assertion failed/);
  assert.equal(current.approvals[0]!.command, process.execPath);
  assert.deepEqual(current.approvals[0]!.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(fixture.taskRuns.length, 1);
  assert.equal(fixture.taskRuns[0]!.exitCode, 7);
  assert.equal(fixture.taskRuns[0]!.terminations, 0);
  assert.match(fixture.taskRuns[0]!.output, /out\r\n/);
  assert.deepEqual(fixture.taskRuns[0]!.task.problemMatchers, []);
  fixture.taskRuns[0]!.terminal.open();
  assert.equal(current.approvals.length, 1);
  const owned = fixture.taskRuns[0]!.task.execution as CustomExecution;
  await assert.rejects(owned.callback({}), /aborted|cancelled/);
  fixture.tasks = [current.processTask('process.stdout.write("x".repeat(80000));')];
  const bounded = await current.invoke();
  assert.equal(bounded.truncated, true);
  assert.equal(Buffer.byteLength(bounded.output), 65536);
});

test('native task preflight preserves dirty text and notebooks without changing task save settings', async (context) => {
  const current = await setup(context);
  fixture.tasks = [current.processTask()];
  const document = new Document(Uri.file(path.join(current.cwd, 'unrelated.md')), 'UNSAVED');
  document.isDirty = true;
  fixture.documents.push(document);
  for (const mode of [undefined, 'always', 'prompt', 'unknown']) {
    if (mode === undefined) fixture.configuration.delete('task.saveBeforeRun');
    else fixture.configuration.set('task.saveBeforeRun', mode);
    await assert.rejects(current.invoke(), /could save dirty/);
    assert.equal(fixture.configuration.get('task.saveBeforeRun'), mode);
  }
  document.isDirty = false;
  const notebook = { isDirty: true };
  fixture.notebook = notebook;
  await assert.rejects(current.invoke(), /could save dirty/);
  assert.equal(current.approvals.length, 0);
  assert.equal(fixture.taskRuns.length, 0);
  document.isDirty = true;
  fixture.configuration.set('task.saveBeforeRun', 'never');
  assert.equal((await current.invoke()).exitStatus.exitCode, 0);
  assert.equal(document.isDirty, true);
  assert.equal(document.getText(), 'UNSAVED');
  assert.equal(notebook.isDirty, true);
  assert.equal(fixture.configuration.get('task.saveBeforeRun'), 'never');
});

test('task shell snapshots quote literal arguments and support explicit command lines', async (context) => {
  const current = await setup(context);
  const literal = "single'quote; $(touch injected.txt)";
  fixture.tasks = [current.task(new ShellExecution('/usr/bin/printf', ['%s', literal]))];
  assert.equal((await current.invoke()).output, literal);
  await assert.rejects(readFile(path.join(current.cwd, 'injected.txt')), { code: 'ENOENT' });
  fixture.tasks = [current.task(new ShellExecution('printf "line\\n"'))];
  assert.equal((await current.invoke()).output, 'line\n');
  assert.deepEqual(current.approvals[1]!.args, ['-c', 'printf "line\\n"']);
  const noArgs = new ShellExecution('/usr/bin/true', []);
  noArgs.args = undefined;
  fixture.tasks = [current.task(noArgs)];
  assert.equal((await current.invoke()).exitStatus.exitCode, 0);
});

test('unavailable, ambiguous, custom, global and background task authority is refused', async (context) => {
  const current = await setup(context);
  await assert.rejects(current.invoke(), /unavailable/);
  fixture.tasks = [current.processTask(), current.processTask()];
  await assert.rejects(current.invoke(), /ambiguous/);
  const background = current.processTask();
  background.isBackground = true;
  const global = current.processTask();
  global.scope = TaskScope.Global;
  const remote = current.processTask();
  remote.scope = { uri: Uri.parse('remote://server/project') };
  for (const task of [
    background,
    global,
    remote,
    current.task(undefined),
    current.task(
      new CustomExecution(async () => {
        throw new Error('Must never execute');
      }),
    ),
  ]) {
    fixture.tasks = [task];
    await assert.rejects(current.invoke(), /workspace|unavailable|Opaque/);
  }
  const workspace = current.processTask();
  workspace.scope = TaskScope.Workspace;
  fixture.tasks = [workspace];
  assert.equal((await current.invoke()).exitStatus.exitCode, 0);
  fixture.roots.push({ uri: Uri.file('/other'), name: 'other', index: 1 });
  await assert.rejects(current.invoke(), /unavailable/);
  fixture.tasks = Array(1001).fill(workspace);
  await assert.rejects(current.invoke(), /1000/);
  assert.equal(current.approvals.length, 1);
});

test('task snapshots reject variables, malformed commands, unsafe directories and shell extensions', async (context) => {
  const current = await setup(context);
  for (const execution of [
    new ProcessExecution(''),
    new ProcessExecution('/bin/echo', ['${input:secret}']),
    new ProcessExecution('/bin/echo', [], { env: { TOKEN: '${env:SECRET}' } }),
    new ProcessExecution('/bin/echo', [], { env: { 'BAD=NAME': 'value' } }),
    new ProcessExecution('/bin/echo', [], { cwd: '${workspaceFolder}' }),
    new ProcessExecution('/bin/echo', [], { cwd: current.privateRoot }),
    new ProcessExecution('/bin/echo', [], { cwd: os.tmpdir() }),
    new ProcessExecution('/bin/echo', ['x'.repeat(32768), 'y'.repeat(32768)]),
    new ShellExecution('echo', [{ value: 'quoted', quoting: 1 }]),
    new ShellExecution('echo ok', undefined, { executable: '/bin/bash' }),
    new ShellExecution('echo ok', undefined, { shellArgs: [] }),
  ]) {
    fixture.tasks = [current.task(execution)];
    await assert.rejects(current.invoke());
  }
  const outside = current.processTask();
  outside.scope = { uri: Uri.file(os.tmpdir()) };
  fixture.tasks = [outside];
  await assert.rejects(current.invoke(), /unavailable/);
  await symlink(os.tmpdir(), path.join(current.cwd, 'escape'));
  fixture.tasks = [current.task(new ProcessExecution('/bin/echo', [], { cwd: 'escape' }))];
  await assert.rejects(current.invoke(), /workspace/);
  assert.equal(current.approvals.length, 0);
});

test('task capture is immutable across approval and native cancellation cannot launch late', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const current = await setup(context, async () => {
    shown();
    return new Promise<boolean>((resolve) => {
      allow = resolve;
    });
  });
  const task = current.processTask('require("node:fs").writeFileSync("late.txt","bad");');
  fixture.tasks = [task];
  const running = current.invoke();
  const rejected = assert.rejects(running, /cancelled/);
  await visible;
  fixture.taskRuns[0]!.terminate();
  await rejected;
  assert.equal(fixture.taskRuns[0]!.terminations, 1);
  allow(true);
  await assert.rejects(readFile(path.join(current.cwd, 'late.txt')), { code: 'ENOENT' });
});

test('task approval snapshot survives provider mutation', async (context) => {
  const current = await setup(context, async () => {
    execution.args[1] = 'process.stdout.write("changed");';
    return true;
  });
  const execution = new ProcessExecution(
    process.execPath,
    ['-e', 'process.stdout.write("original");'],
    { env: { ELECTRON_RUN_AS_NODE: '1' } },
  );
  fixture.tasks = [current.task(execution)];
  assert.equal((await current.invoke()).output, 'original');
});

test('task Stop releases stalled discovery and ignores late provider results', async (context) => {
  const current = await setup(context);
  const previous = tasks.fetchTasks;
  let release!: (tasks: unknown[]) => void;
  tasks.fetchTasks = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  context.after(() => {
    tasks.fetchTasks = previous;
  });
  const running = current.invoke();
  const rejected = assert.rejects(running, /Stopped/);
  current.abort.abort(new Error('Stopped'));
  await rejected;
  release([current.processTask()]);
  assert.equal(current.approvals.length, 0);
  assert.equal(fixture.taskRuns.length, 0);
});

test('task ownership is rechecked after asynchronous discovery', async (context) => {
  const current = await setup(context);
  const previous = tasks.fetchTasks;
  tasks.fetchTasks = async () => {
    current.current.active = false;
    return [current.processTask()];
  };
  context.after(() => {
    tasks.fetchTasks = previous;
  });
  await assert.rejects(current.invoke(), /retired/);
  assert.equal(current.approvals.length, 0);
  current.current.active = true;
  tasks.fetchTasks = previous;
  fixture.roots = [];
  fixture.tasks = [current.processTask()];
  await assert.rejects(current.invoke(), /unavailable/);
});

test(
  'denied task commands create no process and positive timeouts report termination',
  { timeout: 5000 },
  async (context) => {
    let allowed = false;
    const current = await setup(context, async () => allowed);
    fixture.tasks = [current.processTask('require("node:fs").writeFileSync("denied.txt","bad");')];
    await assert.rejects(current.invoke(), /not approved/);
    await assert.rejects(readFile(path.join(current.cwd, 'denied.txt')), { code: 'ENOENT' });
    allowed = true;
    fixture.tasks = [current.processTask('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);')];
    const result = await current.invoke({ name: 'check', source: 'fixture', timeout: 1 });
    assert.equal(result.exitStatus._meta['vs-omp/termination'], 'timeout');
    assert.equal(result.exitStatus.exitCode, null);
  },
);

function readyFile(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(cwd, (_event, fileName) => {
      if (fileName !== 'ready.txt') return;
      watcher.close();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error('Task readiness missing'));
    }, 3000);
  });
}

test(
  'native task cancellation terminates a running process and releases the shared slot',
  { timeout: 5000 },
  async (context) => {
    const current = await setup(context);
    const ready = readyFile(current.cwd);
    fixture.tasks = [
      current.processTask(
        'require("node:fs").writeFileSync("ready.txt",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
      ),
    ];
    const running = current.invoke();
    const rejected = assert.rejects(running, /cancelled/);
    await ready;
    const pid = Number(await readFile(path.join(current.cwd, 'ready.txt'), 'utf8'));
    fixture.taskRuns[0]!.terminate();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    fixture.tasks = [current.processTask()];
    assert.equal((await current.invoke()).exitStatus.exitCode, 0);
  },
);

test('registered task traverses one-use broker permission and actual-command approval', async (context) => {
  const current = await setup(context);
  fixture.tasks = [current.processTask()];
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  const handlers = new Map<string, (event: any) => Promise<void>>();
  installNativeTask({
    on: (name, handler) => {
      handlers.set(name, handler as (event: any) => Promise<void>);
    },
    registerTool: (definition) => {
      tool = definition;
    },
  } as NativeEditApi);
  assert.equal(tool.approval, 'write');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const id = randomUUID();
  const input = { name: 'check', source: 'fixture' };
  const native = { cwd: current.cwd, sessionManager: { getSessionId: () => 'owner' } };
  const execute = () => tool.execute(id, input, current.scope.signal, undefined, native);
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = current.privateRoot;
  let commandApprovals = 0;
  const tools = new HostTools(
    {
      normalize: async () => {
        throw new Error('No file writes');
      },
    },
    {
      read: async () => '',
      write: async () => {
        throw new Error('No file writes');
      },
    },
    path.join(current.privateRoot, 'mutations'),
    async (approval) => {
      commandApprovals++;
      assert.equal(approval.kind, 'command');
      assert.match(approval.details!, /task passed/);
      return true;
    },
  );
  await tools.run({ ...current.scope, owner: 'local' }, async () => {
    await handlers.get('tool_call')!({ toolName: 'other' });
    await handlers.get('tool_result')!({ toolName: 'other' });
    await handlers.get('tool_call')!({ toolName: 'task', toolCallId: id, input });
    const permission = {
      sessionId: 'owner',
      toolCall: { toolCallId: id, rawInput: input },
      options: [{ kind: 'allow_once', optionId: 'once', name: 'Allow Once' }],
    };
    assert.deepEqual(await tools.permission(permission as any), {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    const result = (await execute()) as { content: { text: string }[] };
    assert.equal(JSON.parse(result.content[0]!.text).exitStatus.exitCode, 0);
    await handlers.get('tool_result')!({ toolName: 'task', toolCallId: id });
  });
  assert.equal(commandApprovals, 1);
  await assert.rejects(
    tool.execute(id, input, AbortSignal.abort(new Error('Stopped')), undefined, native),
    /Stopped/,
  );
});
