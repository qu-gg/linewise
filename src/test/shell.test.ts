import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { installNativeShell } from '../native-shell.js';
import { shellPermission, shellRequest } from '../shell-policy.js';
import type { NativeEditApi } from '../native-edit.js';
import { TerminalManager } from '../terminal.js';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { HostTools } = await import('../host-tools.js');

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-managed-shell-'));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(cwd, 'private');
  const abort = new AbortController();
  let allowed = true;
  const commands: string[] = [];
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
    path.join(cwd, 'private', 'mutations'),
    async (prompt) => {
      commands.push(prompt.details);
      return allowed;
    },
  );
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeShell({ registerTool: (definition) => (tool = definition) });
  context.after(async () => {
    await tools.finish();
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  const scope = {
    sessionId: 'native',
    owner: 'local',
    cwd,
    signal: abort.signal,
    valid: () => true,
  };
  const execute = async (input: unknown) => {
    const result = (await tool.execute(randomUUID(), input, abort.signal, undefined, {
      cwd,
      sessionManager: { getSessionId: () => 'native' },
    })) as { content: { text: string }[]; isError: boolean };
    return { ...JSON.parse(result.content[0]!.text), isError: result.isError };
  };
  return { tools, scope, execute, abort, cwd, commands, tool, deny: () => (allowed = false) };
}

test('approval can wait indefinitely before the execution deadline starts', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  let approvalSignal!: AbortSignal;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const approval = new Promise<boolean>((resolve) => {
    allow = resolve;
  });
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 1000,
    approve: async (_command, signal) => {
      approvalSignal = signal;
      shown();
      return approval;
    },
  });
  context.after(() => manager.dispose());
  Reflect.apply(context.mock.timers.enable, context.mock.timers, [{ apis: ['setTimeout'] }]);
  const pending = manager.create({
    sessionId: 'owner',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("after-approval");'],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  });
  void pending.catch(() => {});
  await visible;
  context.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal(approvalSignal.aborted, false);
  context.mock.timers.reset();
  allow(true);
  const request = { sessionId: 'owner', ...(await pending) };
  assert.equal((await manager.waitForExit(request)).exitCode, 0);
  assert.equal(manager.output(request).output, 'after-approval');
});

test('terminal backend creates no execution timer unless explicitly configured', async (context) => {
  const timer = context.mock.method(globalThis, 'setTimeout');
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(() => manager.dispose());
  const handle = await manager.create({
    sessionId: 'owner',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("no-deadline");'],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  });
  assert.equal(timer.mock.callCount(), 0);
  const request = { sessionId: 'owner', ...handle };
  assert.equal((await manager.waitForExit(request)).exitCode, 0);
  assert.equal(manager.output(request).output, 'no-deadline');
});

test('shell schema advertises only owned server operations and explicit host Node execution', () => {
  for (const input of [
    { command: 'pwd' },
    { command: 'console.log(process.version)', runtime: 'node' },
    { command: 'node server.mjs', action: 'start', timeout: null, cwd: '.', pty: false },
    { action: 'output', jobId: randomUUID() },
    { action: 'wait', jobId: randomUUID() },
    { action: 'stop', jobId: randomUUID() },
  ])
    assert.equal(shellRequest.safeParse(input).success, true);
  assert.equal(shellRequest.safeParse({ command: 'pwd', pty: true }).success, true);
  for (const input of [
    { command: 'pwd', pty: 'interactive' },
    { command: 'pwd', visibility: 'unknown' },
    { command: 'pwd', service: true },
    { command: 'pwd', async: true },
    { command: 'pwd', timeout: 121 },
    { action: 'output', jobId: '../../foreign' },
    { action: 'wait', jobId: '../../foreign' },
    { action: 'wait', jobId: randomUUID(), waitMs: 1 },
    { action: 'wait', jobId: randomUUID(), timeout: 1 },
    { action: 'stop', jobId: randomUUID(), command: 'unexpected' },
  ])
    assert.equal(shellRequest.safeParse(input).success, false);
  assert.equal(shellPermission({ command: 'pwd', timeout: null }), '{"command":"pwd"}');
  assert.equal(shellPermission({ unknown: true }), undefined);
  assert.equal(
    shellPermission({ command: 'pwd', action: 'run', i: 'intent' }),
    '{"command":"pwd","action":"run"}',
  );
});

test('registered shell runs through host approvals and returns command errors instead of ACP Internal error', async (context) => {
  const current = await setup(context);
  assert.equal(current.tool.name, 'bash');
  assert.match(current.tool.description, /Approval and execution have no timeout by default/);
  assert.equal(current.tool.parameters.type, 'object');
  assert.equal(current.tool.parameters.anyOf, undefined);
  assert.equal(current.tool.strict, false);
  await current.tools.run(current.scope, async () => {
    const result = await current.execute({
      command: 'console.log(process.version)',
      runtime: 'node',
    });
    assert.equal(result.isError, false);
    assert.match(result.output, /^v(?:2\d|[3-9]\d)\./);
    assert.ok(current.commands[0]!.includes(JSON.stringify(process.execPath)));
    const failed = await current.execute({ command: 'printf failure; exit 7' });
    assert.equal(failed.isError, true);
    assert.equal(failed.exitStatus.exitCode, 7);
    assert.equal(failed.output, 'failure');
    current.deny();
    await assert.rejects(
      current.execute({ command: 'printf DENIED > denied.txt' }),
      /not approved/,
    );
    await assert.rejects(readFile(path.join(current.cwd, 'denied.txt')), /ENOENT/);
    await assert.rejects(current.execute({ action: 'output', jobId: randomUUID() }), /released/);
  });
});

test('foreground execution is unlimited unless a positive per-call timeout is provided', async (context) => {
  const current = await setup(context);
  const create = context.mock.method(TerminalManager.prototype, 'create');
  await current.tools.run(current.scope, async () => {
    for (const timeout of [undefined, null, 0, 1]) {
      const result = await current.execute({ command: 'printf deadline-policy', timeout });
      assert.equal(result.isError, false);
      assert.equal(result.output, 'deadline-policy');
    }
  });
  assert.deepEqual(
    create.mock.calls.map((call) => call.arguments[1]),
    [null, null, null, 1000],
  );
});

test(
  'managed foreground server survives its start call, serves requests, exposes output and stops explicitly',
  { timeout: 10000 },
  async (context) => {
    const current = await setup(context);
    await current.tools.run(current.scope, async () => {
      const server = await current.execute({
        action: 'start',
        runtime: 'node',
        command:
          'import http from "node:http"; const server=http.createServer((_request,response)=>response.end("managed-ok")); server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));',
      });
      assert.match(server.jobId, /^[a-f0-9-]{36}$/);
      const response = await current.execute({
        runtime: 'node',
        command: `const id=${JSON.stringify(server.jobId)};console.log("owned:"+id);`,
      });
      assert.match(response.output, /owned:/);
      const output = await current.execute({ action: 'output', jobId: server.jobId, waitMs: 3000 });
      const { port } = JSON.parse(output.output);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'managed-ok');
      const stopped = await current.execute({ action: 'stop', jobId: server.jobId });
      assert.equal(stopped.isError, false);
      assert.ok(stopped.exitStatus.signal);
      await assert.rejects(current.execute({ action: 'output', jobId: server.jobId }), /released/);
    });
  },
);

test(
  'managed completion holds return final failure and late results without status polling',
  { timeout: 10000 },
  async (context) => {
    const current = await setup(context);
    await current.tools.run(current.scope, async () => {
      const marker = randomUUID();
      const job = await current.execute({
        action: 'start',
        runtime: 'node',
        command:
          'import http from "node:http"; const server=http.createServer((_request,response)=>{response.end("done");server.close(()=>{' +
          `console.log(${JSON.stringify(marker)});process.exitCode=7;` +
          '});});server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({port:server.address().port})));',
      });
      const snapshot = await current.execute({ action: 'output', jobId: job.jobId, waitMs: 3000 });
      const { port } = JSON.parse(snapshot.output);
      assert.equal(
        (await current.execute({ command: 'printf other-safe-work' })).output,
        'other-safe-work',
      );
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      const original = TerminalManager.prototype.waitForExit;
      const wait = context.mock.method(
        TerminalManager.prototype,
        'waitForExit',
        function (this: TerminalManager, request: Parameters<TerminalManager['waitForExit']>[0]) {
          entered();
          return original.call(this, request);
        },
      );
      const output = context.mock.method(TerminalManager.prototype, 'waitForOutput');
      let replies = 0;
      const pending = current.execute({ action: 'wait', jobId: job.jobId }).then((result) => {
        replies++;
        return result;
      });
      await waiting;
      assert.equal(replies, 0);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'done');
      const completed = await pending;
      assert.equal(replies, 1);
      assert.equal(wait.mock.callCount(), 1);
      assert.equal(output.mock.callCount(), 0);
      assert.equal(completed.jobId, job.jobId);
      assert.equal(completed.exitStatus.exitCode, 7);
      assert.equal(completed.isError, true);
      assert.ok(completed.output.includes(marker));
      assert.deepEqual(await current.execute({ action: 'wait', jobId: job.jobId }), completed);
      assert.equal(current.commands.length, 2);
      await assert.rejects(current.execute({ action: 'wait', jobId: randomUUID() }), /released/);
      await current.execute({ action: 'stop', jobId: job.jobId });
      await assert.rejects(current.execute({ action: 'wait', jobId: job.jobId }), /released/);
    });
  },
);

test('Stop releases a pending managed completion hold', { timeout: 10000 }, async (context) => {
  const current = await setup(context);
  await assert.rejects(
    current.tools.run(current.scope, async () => {
      const job = await current.execute({
        action: 'start',
        runtime: 'node',
        command: 'setInterval(()=>{},1000)',
      });
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      const original = TerminalManager.prototype.waitForExit;
      context.mock.method(
        TerminalManager.prototype,
        'waitForExit',
        function (this: TerminalManager, request: Parameters<TerminalManager['waitForExit']>[0]) {
          entered();
          return original.call(this, request);
        },
      );
      const pending = assert.rejects(
        current.execute({ action: 'wait', jobId: job.jobId }),
        (error: unknown) => {
          assert.equal(current.abort.signal.aborted, true);
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /abort|cancel|released|^Native mutation response wait closed\.$/i,
          );
          return true;
        },
      );
      await waiting;
      current.abort.abort();
      await pending;
    }),
    (error: unknown) => error === current.abort.signal.reason,
  );
});

test('managed jobs are terminated when the owning prompt ends and cannot cross prompts', async (context) => {
  const current = await setup(context);
  let jobId = '';
  await current.tools.run(current.scope, async () => {
    const server = await current.execute({
      action: 'start',
      runtime: 'node',
      command: 'setInterval(()=>{},1000)',
    });
    jobId = server.jobId;
  });
  await current.tools.run(current.scope, async () => {
    await assert.rejects(current.execute({ action: 'stop', jobId }), /released/);
    await assert.rejects(current.execute({ action: 'wait', jobId }), /released/);
  });
});
