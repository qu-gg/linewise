import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { displayTools } from '../scripts/test-display.mjs';

const script = path.resolve('scripts/test-display.mjs');
const probe = `
  import assert from 'node:assert/strict';
  import { spawnSync } from 'node:child_process';
  import { displayTools } from './scripts/test-display.mjs';
  const tools = displayTools();
  assert.equal(process.env.WAYLAND_DISPLAY, undefined);
  assert.equal(process.env.VS_OMP_TEST_DISPLAY_ACTIVE, '1');
  const manager = spawnSync(tools.wmctrl, ['-m'], { encoding: 'utf8' });
  assert.equal(manager.status, 0);
  assert.match(manager.stdout, /Openbox/);
  const screen = spawnSync(tools.xdpyinfo, [], { encoding: 'utf8' });
  assert.equal(screen.status, 0);
  assert.match(screen.stdout, /1440x900 pixels/);
  assert.match(screen.stdout, /96x96 dots per inch/);
  console.log('CHILD_PID=' + process.pid);
`;

function fixture(context, source) {
  const child = spawn(process.execPath, [script, '--input-type=module', '-e', probe + source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let release;
  const ready = new Promise((resolve) => (release = resolve));
  const collect = (chunk) => {
    output += chunk.toString();
    if (output.includes('CHILD_READY')) release();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      release();
      resolve({ code, signal });
    });
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  return { child, ready, done, output: () => output };
}

async function evidence(run) {
  const match = /Evidence: ([^\r\n]+)/.exec(run.output());
  assert.ok(match, run.output());
  const directory = match[1];
  assert.ok(directory.startsWith(`${path.resolve('reports/test-display')}${path.sep}run-`));
  const session = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
  return { directory, session };
}

async function cleaned(run) {
  const { directory, session } = await evidence(run);
  const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(result.authorityRemoved, true);
  await assert.rejects(access(path.join(directory, 'Xauthority')), { code: 'ENOENT' });
  assert.throws(() => process.kill(session.windowManagerPid, 0), { code: 'ESRCH' });
  const display = spawnSync(displayTools().xdpyinfo, ['-display', session.display], {
    stdio: 'pipe',
  });
  assert.notEqual(display.status, 0, 'The fixture X server must stop.');
  const pid = Number(/CHILD_PID=(\d+)/.exec(run.output())?.[1]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'result.json'))).mode & 0o777, 0o600);
  return { session, result };
}

test(
  'quiet displays isolate concurrent sessions and preserve success and failure status',
  { timeout: 30_000 },
  async (context) => {
    const held = (status) => `const timer = setInterval(() => {}, 1_000);
    process.on('SIGUSR2', () => { clearInterval(timer); process.exitCode = ${status}; });
    console.log('CHILD_READY');`;
    const first = fixture(context, held(0));
    const second = fixture(context, held(7));
    await Promise.all([first.ready, second.ready]);
    const active = await Promise.all([evidence(first), evidence(second)]);
    assert.notEqual(active[0].session.display, active[1].session.display);
    for (const run of [first, second]) {
      process.kill(Number(/CHILD_PID=(\d+)/.exec(run.output())?.[1]), 'SIGUSR2');
    }
    const exits = await Promise.all([first.done, second.done]);
    assert.deepEqual(exits, [
      { code: 0, signal: null },
      { code: 7, signal: null },
    ]);
    const [success, failure] = await Promise.all([cleaned(first), cleaned(second)]);
    assert.equal(success.result.status, 0);
    assert.equal(failure.result.status, 7);
    assert.notEqual(success.session.display, process.env.DISPLAY);
    assert.notEqual(success.session.display, failure.session.display);
    assert.notEqual(success.session.busHash, failure.session.busHash);
    const parentBus = createHash('sha256')
      .update(process.env.DBUS_SESSION_BUS_ADDRESS ?? '')
      .digest('hex');
    assert.notEqual(success.session.busHash, parentBus);
  },
);

test(
  'SIGTERM cancels the owned test and removes the private desktop',
  { timeout: 30_000 },
  async (context) => {
    const run = fixture(
      context,
      "console.log('CHILD_READY'); process.stdin.resume(); setInterval(() => {}, 1_000);",
    );
    await run.ready;
    assert.match(run.output(), /CHILD_READY/);
    run.child.kill('SIGTERM');
    const exit = await run.done;
    assert.notEqual(exit.code, 0);
    await cleaned(run);
  },
);

test(
  'window-manager failure stops even a TERM-resistant test without a visible fallback',
  { timeout: 30_000 },
  async (context) => {
    const run = fixture(
      context,
      "process.on('SIGTERM', () => {}); console.log('CHILD_READY'); setInterval(() => {}, 1_000);",
    );
    await run.ready;
    assert.match(run.output(), /CHILD_READY/);
    const { session } = await evidence(run);
    process.kill(session.windowManagerPid, 'SIGTERM');
    const exit = await run.done;
    assert.notEqual(exit.code, 0);
    assert.match(run.output(), /Private window manager exited during testing/);
    await cleaned(run);
  },
);
