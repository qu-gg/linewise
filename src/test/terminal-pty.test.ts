import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { PtyTerminal } from '../terminal-pty.js';
import { TerminalManager } from '../terminal.js';
import { executeShell } from '../shell.js';
import { shellPermission, shellRequest } from '../shell-policy.js';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { guardReason } = await import('../omp-guard.js');

function fixture(
  context: TestContext,
  command: string,
  limit = 65536,
  timeout: number | null = null,
) {
  let rendered = '';
  const terminal = new PtyTerminal(
    {
      command: '/bin/bash',
      args: ['-c', command],
      cwd: process.cwd(),
      env: {},
      outputByteLimit: limit,
    },
    timeout,
    (text) => {
      rendered += text;
    },
  );
  context.after(async () => {
    terminal.terminate('test-cleanup');
    await terminal.done;
    terminal.assertCleanup();
  });
  return { terminal, rendered: () => rendered };
}

test('PTY backend uses a real terminal and retains a nonzero outcome', async (context) => {
  const { terminal } = fixture(context, 'test -t 0 && test -t 1 && printf REAL_PTY; exit 7');
  await terminal.ready;
  assert.equal((await terminal.done).exitCode, 7);
  assert.equal(terminal.snapshot().output, 'REAL_PTY');
  assert.equal(terminal.input('blocked'), false);
});

test('PTY capture is bounded without splitting UTF-8 characters', async (context) => {
  const { terminal } = fixture(context, "printf '\\360\\237\\230\\200abc'", 5);
  await terminal.done;
  assert.equal(terminal.snapshot().output, 'abc');
  assert.equal(terminal.snapshot().truncated, true);
});

test('fast concurrent PTYs drain before cached late waits and cannot cross identities', async (context) => {
  const terminals: PtyTerminal[] = [];
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
    launch: (command, timeout) => {
      const terminal = new PtyTerminal(command, timeout, () => {});
      terminals.push(terminal);
      return terminal;
    },
  });
  context.after(() => manager.dispose());
  const handles = [];
  for (const index of [0, 1, 2, 3]) {
    handles.push(
      await manager.create(
        {
          sessionId: 'owner',
          command: '/bin/bash',
          args: ['-c', `printf JOB${index}:; printf '%01024d' 0; printf :END; exit ${index}`],
        },
        null,
        undefined,
        { pty: true, visibility: 'hidden' },
      ),
    );
  }
  await Promise.all(terminals.map((terminal) => terminal.done));
  await Promise.all(
    handles.map(async (handle, index) => {
      const request = { sessionId: 'owner', ...handle };
      const outcomes = await Promise.all([
        manager.waitForExit(request),
        manager.waitForExit(request),
      ]);
      assert.deepEqual(outcomes, [
        { exitCode: index, signal: null },
        { exitCode: index, signal: null },
      ]);
      assert.equal(manager.output(request).output, `JOB${index}:${'0'.repeat(1024)}:END`);
      outcomes[0]!.exitCode = 99;
      assert.equal((await manager.waitForExit(request)).exitCode, index);
      await assert.rejects(
        manager.waitForExit({ ...request, sessionId: 'foreign' }),
        /another session/,
      );
      await assert.rejects(
        manager.waitForExit({ ...request, terminalId: randomUUID() }),
        /Unknown or released terminal/,
      );
    }),
  );
});

test('signal termination remains an explicit unknown exit rather than success', async (context) => {
  const abort = new AbortController();
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: abort.signal,
    approve: async () => true,
    launch: (command, timeout) => new PtyTerminal(command, timeout, () => {}),
  });
  context.after(() => manager.dispose());
  const result = JSON.parse(
    await executeShell(
      manager,
      'owner',
      process.cwd(),
      {
        command: 'kill -TERM $$',
        pty: true,
      },
      abort.signal,
    ),
  );
  assert.equal(result.exitStatus.exitCode, null);
  assert.equal(result.exitStatus.signal, 'SIGTERM');
  assert.notEqual(result.exitStatus.exitCode, 0);
});

test('human input is excluded until takeover and its output never reopens to the model', async (context) => {
  const { terminal, rendered } = fixture(
    context,
    'printf READY; IFS= read -r value; printf "%s" "$value"',
  );
  await terminal.waitForOutput(3000);
  assert.equal(terminal.snapshot().output, 'READY');
  assert.equal(terminal.input('blocked\r'), false);
  terminal.beginTakeover();
  assert.throws(() => terminal.beginTakeover(), /not available/);
  const value = 'synthetic-keyboard-only';
  assert.equal(terminal.input(`${value}\r`), true);
  await terminal.done;
  terminal.endTakeover();
  assert.ok(rendered().includes(value));
  assert.equal(terminal.snapshot().output, '');
  assert.equal(terminal.snapshot()._meta?.['vs-omp/capture'], 'withheld-after-takeover');
  assert.throws(() => terminal.beginTakeover(), /not available/);
});

test('PTY deadline and explicit stop settle the actual process', async (context) => {
  const { terminal } = fixture(context, 'IFS= read -r value', 65536, 20);
  const status = await terminal.done;
  assert.notEqual(status.exitCode, 0);
  assert.equal(status._meta?.['vs-omp/termination'], 'timeout');
  terminal.terminate('again');
  terminal.resize(80, 24);
});

test('PTY waits are event driven and validated resizing does not enable input', async (context) => {
  const { terminal } = fixture(context, 'printf READY; IFS= read -r value');
  assert.equal((await terminal.waitForOutput(0)).output, '');
  assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
  terminal.resize(100, 30);
  assert.throws(() => terminal.resize(0, 30), /dimensions/);
  assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
  terminal.terminate('stop');
  assert.notEqual((await terminal.done).exitCode, 0);
});

test('shell PTY, visibility and scheduling stay independent under one owned manager', async (context) => {
  const abort = new AbortController();
  let revealed = 0;
  let approved = 0;
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: abort.signal,
    approve: async () => {
      approved++;
      return true;
    },
    launch: (command, timeout, execution) => {
      assert.deepEqual(execution, { pty: true, visibility: 'background' });
      return Object.assign(new PtyTerminal(command, timeout, () => {}), {
        reveal: () => {
          revealed++;
        },
        takeover: async () => {},
      });
    },
  });
  context.after(() => manager.dispose());
  const result = JSON.parse(
    await executeShell(
      manager,
      'owner',
      process.cwd(),
      {
        command: 'printf OWNED',
        action: 'start',
        pty: true,
        visibility: 'background',
      },
      abort.signal,
    ),
  );
  const request = { sessionId: 'owner', terminalId: result.jobId };
  await manager.waitForExit(request);
  await executeShell(
    manager,
    'owner',
    process.cwd(),
    { action: 'reveal', jobId: result.jobId },
    abort.signal,
  );
  assert.equal(approved, 1);
  assert.equal(revealed, 1);
  assert.throws(() => manager.reveal({ ...request, sessionId: 'other' }), /another session/);
  await manager.takeover(request);
  assert.equal(
    shellRequest.safeParse({ action: 'takeover', jobId: result.jobId, command: 'extra' }).success,
    false,
  );
  assert.notEqual(
    shellPermission({ command: 'same', pty: true }),
    shellPermission({ command: 'same' }),
  );
});

test('a PTY request without a host backend cannot silently become a pipe command', async (context) => {
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(() => manager.dispose());
  await assert.rejects(
    manager.create({ sessionId: 'owner', command: '/bin/true' }, null, undefined, {
      pty: true,
      visibility: 'hidden',
    }),
    /unavailable/,
  );
  const request = {
    sessionId: 'owner',
    ...(await manager.create({ sessionId: 'owner', command: '/bin/true' })),
  };
  await manager.waitForExit(request);
  assert.throws(() => manager.reveal(request), /cannot be revealed/);
  await assert.rejects(manager.takeover(request), /does not support/);
});

test('guard accepts only exact owned-operation request shapes for reveal and takeover', () => {
  for (const action of ['reveal', 'takeover']) {
    assert.equal(
      guardReason({ toolName: 'bash', input: { action, jobId: randomUUID() } }),
      undefined,
    );
    for (const input of [
      { action, jobId: 'foreign' },
      { action, jobId: randomUUID(), command: 'extra' },
      { action, jobId: randomUUID(), waitMs: 1 },
    ])
      assert.match(guardReason({ toolName: 'bash', input })!, /valid owned jobId/);
  }
});

async function assertStopped(pid: number, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (/^[ZX]$/.test(fields[0]!)) return;
      if (Number(fields[6]) & 4 && fields[20] === '0') return;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await tick(undefined, { signal });
  }
}

test(
  'PTY parent exit, Stop and deadline stop owned descendants including TERM-resistant processes',
  { timeout: 5000 },
  async (context) => {
    for (const mode of ['exit', 'stop', 'deadline']) {
      const childSource = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
      const source =
        'const child=require("node:child_process").spawn(process.execPath,["-e",' +
        JSON.stringify(childSource) +
        '],{stdio:"ignore"});' +
        'process.on("SIGTERM",()=>{});child.once("spawn",()=>{process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})+"\\n");' +
        (mode === 'exit' ? 'process.exit(0);' : 'setInterval(()=>{},1000);') +
        '});';
      const terminal = new PtyTerminal(
        {
          command: process.execPath,
          args: ['-e', source],
          cwd: process.cwd(),
          env: { ELECTRON_RUN_AS_NODE: '1' },
          outputByteLimit: 65536,
        },
        mode === 'deadline' ? 500 : null,
        () => {},
      );
      context.after(async () => {
        terminal.terminate('test-cleanup');
        await terminal.done;
      });
      const output = await terminal.waitForOutput(3000);
      const pids = JSON.parse(output.output) as { parent: number; child: number };
      if (mode === 'stop') terminal.terminate('stop');
      const status = await terminal.done;
      assert.equal(status.exitCode === 0, mode === 'exit');
      terminal.assertCleanup();
      for (const pid of [pids.parent, pids.child]) await assertStopped(pid, context.signal);
    }
  },
);
