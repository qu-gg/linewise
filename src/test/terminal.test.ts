import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { CreateTerminalRequest } from '@agentclientprotocol/sdk';
import { AgentApp } from '@agentclientprotocol/sdk';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../terminal.js';
import type { TerminalOptions } from '../terminal.js';
import { createClientApp } from '../acp.js';

async function fixture(
  context: TestContext,
  options: Partial<Pick<TerminalOptions, 'approve' | 'timeoutMs'>> = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-safety-'));
  const abort = new AbortController();
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd,
    signal: abort.signal,
    approve: async () => true,
    ...options,
  });
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, abort, manager };
}

function command(
  source: string,
  overrides: Partial<CreateTerminalRequest> = {},
): CreateTerminalRequest {
  return {
    sessionId: 'owner',
    command: process.execPath,
    args: ['-e', source],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    ...overrides,
  };
}

function marker(cwd: string): Promise<{ parent: number; child: number }> {
  return new Promise((resolve, reject) => {
    const watcher = watch(cwd, (_event, fileName) => {
      if (fileName !== 'ready.json') return;
      watcher.close();
      clearTimeout(timer);
      void readFile(path.join(cwd, 'ready.json'), 'utf8').then(JSON.parse).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error('Terminal fixture did not signal readiness.'));
    }, 3000);
    watcher.once('error', (error) => {
      watcher.close();
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function notRunning(
  pid: number,
  readStatus: (file: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<void> {
  try {
    assert.match(await readStatus(`/proc/${pid}/stat`, 'utf8'), /\) [ZX] /);
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

test('process liveness accepts disappearing proc entries but rejects other errors and live processes', async () => {
  const readError = (code: string) => () => Promise.reject(Object.assign(new Error(), { code }));
  for (const code of ['ENOENT', 'ESRCH']) {
    await notRunning(123, readError(code));
  }
  await assert.rejects(notRunning(123, readError('EACCES')), { code: 'EACCES' });
  await assert.rejects(
    notRunning(123, async () => '123 (fixture) S 0'),
    assert.AssertionError,
  );
  await notRunning(123, async () => '123 (fixture) Z 0');
});

test('approved terminal captures both streams, cwd, explicit environment and exit status', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-'));
  const abort = new AbortController();
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd,
    signal: abort.signal,
    approve: async (command) => {
      assert.equal(command.cwd, cwd);
      assert.equal(command.command, process.execPath);
      assert.deepEqual(command.env, { VS_OMP_TEST_VALUE: 'explicit', ELECTRON_RUN_AS_NODE: '1' });
      return true;
    },
  });
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const handle = await manager.create({
    sessionId: 'owner',
    command: process.execPath,
    cwd,
    args: [
      '-e',
      'process.stdout.write(process.cwd()+":"+process.env.VS_OMP_TEST_VALUE);process.stderr.write(" stderr");process.exitCode=7;',
    ],
    env: [
      { name: 'VS_OMP_TEST_VALUE', value: 'explicit' },
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    ],
  });
  const request = { sessionId: 'owner', ...handle };
  assert.equal((await manager.waitForExit(request)).exitCode, 7);
  const result = manager.output(request);
  assert.ok(result.output.includes(`${cwd}:explicit`));
  assert.ok(result.output.includes(' stderr'));
  assert.equal(result.truncated, false);
  await manager.release(request);
  assert.throws(() => manager.output(request), /released/);
});

test('rejected approval cannot execute a command and does not poison later requests', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-denied-'));
  let allowed = false;
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd,
    signal: new AbortController().signal,
    approve: async () => allowed,
  });
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const request = {
    sessionId: 'owner',
    command: process.execPath,
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    args: ['-e', 'require("node:fs").writeFileSync("must-not-exist.txt","bad");'],
  };
  await assert.rejects(manager.create(request), /not approved/);
  await assert.rejects(readFile(path.join(cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
  allowed = true;
  const handle = await manager.create({
    sessionId: 'owner',
    command: process.execPath,
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    args: ['-e', 'process.stdout.write("ok");'],
  });
  await manager.waitForExit({ sessionId: 'owner', ...handle });
  assert.equal(manager.output({ sessionId: 'owner', ...handle }).output, 'ok');
});

test('output retains a valid UTF-8 tail within the requested byte limit', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-output-'));
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd,
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const handle = await manager.create({
    sessionId: 'owner',
    command: process.execPath,
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    args: ['-e', 'process.stdout.write("prefix"+String.fromCodePoint(0x1f642).repeat(100));'],
    outputByteLimit: 9,
  });
  const request = { sessionId: 'owner', ...handle };
  await manager.waitForExit(request);
  const result = manager.output(request);
  assert.equal(result.output, String.fromCodePoint(0x1f642).repeat(2));
  assert.equal(Buffer.byteLength(result.output), 8);
  assert.equal(result.truncated, true);
});

test('pending approval is cancelled promptly and a late allow cannot execute', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const approval = new Promise<boolean>((resolve) => {
    allow = resolve;
  });
  const { manager, cwd, abort } = await fixture(context, {
    approve: async () => {
      shown();
      return approval;
    },
  });
  const creating = manager.create(command('require("node:fs").writeFileSync("late.txt","bad");'));
  const rejected = assert.rejects(creating, /cancelled|disposed/);
  await visible;
  abort.abort();
  await rejected;
  allow(true);
  await manager.dispose();
  await assert.rejects(readFile(path.join(cwd, 'late.txt')), { code: 'ENOENT' });
  await assert.rejects(manager.create(command('')), /cancelled|disposed/);
});

test('request and approval mutations cannot change the approved execution snapshot', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const { manager } = await fixture(context, {
    approve: async (approved) => {
      approved.args[1] = 'process.stdout.write("changed by callback");';
      shown();
      return new Promise<boolean>((resolve) => {
        allow = resolve;
      });
    },
  });
  const request = command('process.stdout.write("original");');
  const creating = manager.create(request);
  await visible;
  request.args![1] = 'process.stdout.write("changed by caller");';
  allow(true);
  const owned = { sessionId: 'owner', ...(await creating) };
  await manager.waitForExit(owned);
  assert.equal(manager.output(owned).output, 'original');
});

test('cwd approval refuses symlink escapes, invalid targets and approval-time retargeting', async (context) => {
  const { manager, cwd } = await fixture(context, {
    approve: async () => {
      await unlink(path.join(cwd, 'alias'));
      await symlink(path.join(cwd, 'second'), path.join(cwd, 'alias'));
      return true;
    },
  });
  await mkdir(path.join(cwd, 'first'));
  await mkdir(path.join(cwd, 'second'));
  await symlink(path.join(cwd, 'first'), path.join(cwd, 'alias'));
  await writeFile(path.join(cwd, 'file.txt'), 'text');
  await assert.rejects(manager.create(command('', { cwd: 'relative' })), /absolute/);
  await assert.rejects(manager.create(command('', { cwd: os.tmpdir() })), /inside/);
  await assert.rejects(
    manager.create(command('', { cwd: path.join(cwd, 'file.txt') })),
    /directory/,
  );
  await assert.rejects(
    manager.create(command('', { cwd: path.join(cwd, 'alias') })),
    /changed during approval/,
  );
});

test('invalid inputs and aggregate payloads are rejected before approval', async (context) => {
  let approvals = 0;
  const { manager } = await fixture(context, {
    approve: async () => {
      approvals++;
      return true;
    },
  });
  for (const override of [
    { command: '' },
    { command: '\0' },
    { args: ['\0'] },
    { args: Array(257).fill('x') },
    { args: ['x'.repeat(32_768), 'y'.repeat(32_768)] },
    { env: [{ name: 'INVALID=NAME', value: 'x' }] },
    { env: [{ name: 'NAME', value: '\0' }] },
    { outputByteLimit: -1 },
    { outputByteLimit: 1_048_577 },
    { outputByteLimit: Number.NaN },
  ])
    await assert.rejects(manager.create(command('', override)));
  assert.equal(approvals, 0);
});

test('unknown sessions and terminal IDs cannot read, kill, release or await another terminal', async (context) => {
  const { manager } = await fixture(context);
  await assert.rejects(manager.create(command('', { sessionId: 'other' })), /another session/);
  const handle = await manager.create(command('process.stdout.write("owned");'));
  const request = { sessionId: 'owner', ...handle };
  await manager.waitForExit(request);
  for (const invalid of [
    { ...request, sessionId: 'other' },
    { ...request, terminalId: 'guessed' },
  ]) {
    assert.throws(() => manager.output(invalid));
    await assert.rejects(manager.waitForExit(invalid));
    await assert.rejects(manager.kill(invalid));
    await assert.rejects(manager.release(invalid));
  }
  const result = manager.output(request);
  result.exitStatus!.exitCode = 999;
  assert.equal((await manager.waitForExit(request)).exitCode, 0);
  await manager.kill(request);
});

test('pending reservations and retained terminal count stay bounded and release frees a slot', async (context) => {
  const { manager } = await fixture(context);
  const creating = Array.from({ length: 4 }, () => manager.create(command('')));
  await assert.rejects(manager.create(command('')), /Release a terminal/);
  const handles = await Promise.all(creating);
  await Promise.all(
    handles.map((handle) => manager.waitForExit({ sessionId: 'owner', ...handle })),
  );
  await assert.rejects(manager.create(command('')), /Release a terminal/);
  await manager.release({ sessionId: 'owner', ...handles[0]! });
  const replacement = await manager.create(command(''));
  await manager.waitForExit({ sessionId: 'owner', ...replacement });
});

test('spawn failures release reservations and zero-byte output retains nothing', async (context) => {
  const { manager, cwd } = await fixture(context);
  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(
      manager.create(command('', { command: path.join(cwd, 'missing-executable') })),
      { code: 'ENOENT' },
    );
  const handle = await manager.create(
    command('process.stdout.write("not retained");', { outputByteLimit: 0 }),
  );
  const request = { sessionId: 'owner', ...handle };
  await manager.waitForExit(request);
  assert.equal(manager.output(request).output, '');
  assert.equal(manager.output(request).truncated, true);
});

test(
  'hard deadline terminates a command and records a timeout instead of success',
  { timeout: 5000 },
  async (context) => {
    const { manager } = await fixture(context, { timeoutMs: 200 });
    const handle = await manager.create(
      command('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'),
    );
    const status = await manager.waitForExit({ sessionId: 'owner', ...handle });
    assert.equal(status._meta?.['vs-omp/termination'], 'timeout');
    assert.equal(status.exitCode, null);
    assert.ok(status.signal);
  },
);

test(
  'kill escalates for a TERM-resistant process group and retains output until release',
  { timeout: 5000 },
  async (context) => {
    const { manager, cwd } = await fixture(context);
    const child =
      'process.on("SIGTERM",()=>{});const fs=require("node:fs");fs.writeFileSync("ready.tmp",JSON.stringify({parent:process.ppid,child:process.pid}));fs.renameSync("ready.tmp","ready.json");setInterval(()=>{},1000);';
    const source = `process.on("SIGTERM",()=>{});require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:["ignore","inherit","inherit"]});`;
    const ready = marker(cwd);
    const handle = await manager.create(command(source));
    const pids = await ready;
    const request = { sessionId: 'owner', ...handle };
    assert.equal(manager.output(request).exitStatus, undefined);
    await manager.kill(request);
    assert.equal((await manager.waitForExit(request)).signal, 'SIGKILL');
    assert.equal(manager.output(request).exitStatus?._meta?.['vs-omp/termination'], 'kill');
    await notRunning(pids.parent);
    await notRunning(pids.child);
    await manager.release(request);
  },
);

test(
  'scope cancellation and release terminate active processes, and disposal is idempotent',
  { timeout: 5000 },
  async (context) => {
    const { manager, abort } = await fixture(context);
    const first = await manager.create(command('setInterval(()=>{},1000);'));
    const request = { sessionId: 'owner', ...first };
    await manager.release(request);
    await assert.rejects(manager.release(request), /released/);
    const second = await manager.create(command('setInterval(()=>{},1000);'));
    const waiting = manager.waitForExit({ sessionId: 'owner', ...second });
    abort.abort();
    const closing = manager.dispose();
    assert.equal(manager.dispose(), closing);
    await closing;
    assert.equal((await waiting)._meta?.['vs-omp/termination'], 'dispose');
  },
);

test('the official SDK routes all five terminal operations only to an injected backend', async (context) => {
  const { manager, cwd } = await fixture(context);
  const agent = new AgentApp().onRequest('session/new', async ({ client }) => {
    const handle = await client.request(
      'terminal/create',
      command('process.stdout.write("ACP terminal");'),
    );
    const request = { sessionId: 'owner', ...handle };
    assert.equal((await client.request('terminal/wait_for_exit', request)).exitCode, 0);
    assert.equal((await client.request('terminal/output', request)).output, 'ACP terminal');
    await client.request('terminal/release', request);
    await assert.rejects(client.request('terminal/output', request), { code: -32603 });
    const running = await client.request('terminal/create', command('setInterval(()=>{},1000);'));
    await client.request('terminal/kill', { sessionId: 'owner', ...running });
    assert.ok(
      (await client.request('terminal/wait_for_exit', { sessionId: 'owner', ...running })).signal,
    );
    await client.request('terminal/release', { sessionId: 'owner', ...running });
    return { sessionId: 'owner' };
  });
  const connection = createClientApp({
    terminals: manager,
    update: async () => {},
    read: async () => '',
    write: async () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }).connect(agent);
  context.after(() => connection.close());
  await connection.agent.request('session/new', { cwd, mcpServers: [] });
});

test('host-private environment is not inherited and argument metacharacters are not shell-parsed', async (context) => {
  const { manager, cwd } = await fixture(context);
  const previous = process.env.VS_OMP_TEST_SECRET;
  process.env.VS_OMP_TEST_SECRET = 'fixture-only-secret';
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_TEST_SECRET;
    else process.env.VS_OMP_TEST_SECRET = previous;
  });
  const literal = 'literal; echo unexpected > must-not-exist.txt';
  const request = command(
    'process.stdout.write(JSON.stringify({argument:process.argv[1],secret:!!process.env.VS_OMP_TEST_SECRET,artifacts:!!process.env.VS_OMP_ARTIFACTS_ROOT}));',
  );
  request.args!.push(literal);
  const handle = { sessionId: 'owner', ...(await manager.create(request)) };
  await manager.waitForExit(handle);
  assert.deepEqual(JSON.parse(manager.output(handle).output), {
    argument: literal,
    secret: false,
    artifacts: false,
  });
  await assert.rejects(readFile(path.join(cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test(
  'normal parent exit also terminates remaining background children in its group',
  { timeout: 5000 },
  async (context) => {
    const { manager, cwd } = await fixture(context);
    const ready = marker(cwd);
    const source =
      'const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000);"],{stdio:["ignore","inherit","inherit"]});child.once("spawn",()=>{fs.writeFileSync("ready.tmp",JSON.stringify({parent:process.pid,child:child.pid}));fs.renameSync("ready.tmp","ready.json");process.exit(0);});';
    const handle = { sessionId: 'owner', ...(await manager.create(command(source))) };
    const pids = await ready;
    assert.equal((await manager.waitForExit(handle)).exitCode, 0);
    await notRunning(pids.parent);
    await notRunning(pids.child);
  },
);

test('managed output waits for data, process close or its own bounded deadline', async (context) => {
  const { manager } = await fixture(context);
  const delayed = {
    sessionId: 'owner',
    ...(await manager.create(command('setTimeout(()=>process.stderr.write("ready"),80);'))),
  };
  assert.equal((await manager.waitForOutput(delayed, 2000)).output, 'ready');
  await manager.waitForExit(delayed);
  await manager.release(delayed);
  const silent = { sessionId: 'owner', ...(await manager.create(command(''))) };
  assert.equal((await manager.waitForOutput(silent, 2000)).exitStatus?.exitCode, 0);
  await manager.release(silent);
  const running = {
    sessionId: 'owner',
    ...(await manager.create(command('setInterval(()=>{},1000);'), null)),
  };
  assert.equal((await manager.waitForOutput(running, 10)).output, '');
  assert.throws(() => manager.waitForOutput(running, -1));
  await manager.release(running);
});

test('cancellation during cwd preparation never opens an approval prompt', async (context) => {
  let approvals = 0;
  const { manager, abort } = await fixture(context, {
    approve: async () => {
      approvals++;
      return true;
    },
  });
  const creating = manager.create(command(''));
  abort.abort();
  await assert.rejects(creating, /cancelled|disposed/);
  assert.equal(approvals, 0);
});
