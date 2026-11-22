import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, openSync, watch } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localRoot = fileURLToPath(new URL('../.local-dev/test-display/', import.meta.url));
const script = fileURLToPath(import.meta.url);

export function displayMode(env = process.env, platform = process.platform) {
  const mode = env.VS_OMP_TEST_DISPLAY ?? (platform === 'linux' ? 'quiet' : 'visible');
  if (!['quiet', 'visible'].includes(mode)) throw new Error('Invalid VS_OMP_TEST_DISPLAY mode.');
  if (mode === 'quiet' && platform !== 'linux') {
    throw new Error('Quiet test displays are currently supported only on Linux.');
  }
  return mode;
}

export function findDisplayTool(name, searchPath) {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(
    `Missing ${name}. See QUALITY.md: Quiet Linux Native Tests. No visible fallback.`,
  );
}

export function displayTools(env = process.env) {
  const searchPath = [path.join(localRoot, 'usr/bin'), '/usr/bin', env.PATH ?? ''].join(
    path.delimiter,
  );
  return Object.fromEntries(
    [
      'Xvfb',
      'xvfb-run',
      'xauth',
      'openbox',
      'dbus-run-session',
      'dbus-daemon',
      'wmctrl',
      'xdpyinfo',
    ].map((name) => [name, findDisplayTool(name, searchPath)]),
  );
}

export function displayEnvironment(env, tools) {
  const result = {
    ...env,
    PATH: [path.dirname(tools.Xvfb), '/usr/bin', env.PATH ?? ''].join(path.delimiter),
    VS_OMP_TEST_DISPLAY_ACTIVE: '1',
  };
  for (const key of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'DBUS_SESSION_BUS_PID',
    'DBUS_SESSION_BUS_WINDOWID',
    'DBUS_STARTER_ADDRESS',
    'DBUS_STARTER_BUS_TYPE',
    'SESSION_MANAGER',
    'DESKTOP_STARTUP_ID',
    'GNOME_KEYRING_CONTROL',
    'AT_SPI_BUS_ADDRESS',
  ]) {
    delete result[key];
  }
  return result;
}

export function windowManagerEnvironment(env = process.env) {
  const directory = path.join(localRoot, 'usr/lib/x86_64-linux-gnu');
  if (!existsSync(directory)) return env;
  return {
    ...env,
    LD_LIBRARY_PATH: [directory, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
  };
}

function killOwned(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function ownedProcess(file, args, options = {}) {
  const child = spawn(file, args, { stdio: 'inherit', detached: true, ...options });
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => killOwned(child, signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? 128 + os.constants.signals[signal]));
  }).finally(() => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  });
  return { child, done };
}

async function stopOwned(process) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  killOwned(process.child, 'SIGTERM');
  const timer = setTimeout(() => killOwned(process.child, 'SIGKILL'), 1_000);
  try {
    await process.done;
  } finally {
    clearTimeout(timer);
  }
}

function windowManagerReady(directory) {
  let watcher;
  let timer;
  const ready = new Promise((resolve, reject) => {
    watcher = watch(directory, (_event, name) => {
      if (name === 'wm.ready') resolve();
    });
    watcher.on('error', reject);
    timer = setTimeout(() => reject(new Error('Private window manager did not start.')), 15_000);
  });
  return {
    ready,
    dispose() {
      watcher.close();
      clearTimeout(timer);
    },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function openWindowManager(directory) {
  const tools = displayTools();
  const log = openSync(path.join(directory, 'openbox.log'), 'wx', 0o600);
  try {
    return ownedProcess(
      tools.openbox,
      [
        '--sm-disable',
        '--config-file',
        path.join(directory, 'openbox.xml'),
        '--startup',
        [process.execPath, script, '--ready', directory].map(shellQuote).join(' '),
      ],
      {
        stdio: ['ignore', log, log],
        env: windowManagerEnvironment({
          ...process.env,
          XDG_CONFIG_HOME: path.join(directory, 'config'),
          XDG_DATA_DIRS: `${path.join(localRoot, 'usr/share')}:/usr/share`,
        }),
      },
    );
  } finally {
    closeSync(log);
  }
}

function assertPrivateSession(env) {
  if (!/^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? '') || !env.XAUTHORITY) {
    throw new Error('Quiet tests require the owned X display and authority file.');
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS || env.WAYLAND_DISPLAY) {
    throw new Error('Quiet tests require the private D-Bus session without inherited Wayland.');
  }
}

async function runSession(directory, args) {
  assertPrivateSession(process.env);
  const readiness = windowManagerReady(directory);
  const manager = openWindowManager(directory);
  let command;
  try {
    await Promise.race([
      readiness.ready,
      manager.done.then((status) => {
        throw new Error(`Private window manager exited before readiness (${status}).`);
      }),
    ]);
    readiness.dispose();
    await writeFile(
      path.join(directory, 'session.json'),
      `${JSON.stringify(
        {
          display: process.env.DISPLAY,
          busHash: createHash('sha256').update(process.env.DBUS_SESSION_BUS_ADDRESS).digest('hex'),
          windowManagerPid: manager.child.pid,
          screen: '1440x900x24',
          dpi: 96,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Quiet GUI tests: ${process.env.DISPLAY}, private D-Bus, Openbox. Evidence: ${directory}`,
    );
    command = ownedProcess(process.execPath, args);
    return await Promise.race([
      command.done,
      manager.done.then((status) => {
        throw new Error(`Private window manager exited during testing (${status}).`);
      }),
    ]);
  } finally {
    readiness.dispose();
    if (command) await stopOwned(command);
    await stopOwned(manager);
  }
}

async function prepareDisplay() {
  const reports = path.resolve('reports/test-display');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  await chmod(reports, 0o700);
  const directory = await mkdtemp(path.join(reports, 'run-'));
  await mkdir(path.join(directory, 'runtime'), { mode: 0o700 });
  await writeFile(path.join(directory, 'Xauthority'), '', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(directory, 'xvfb.log'), '', { mode: 0o600, flag: 'wx' });
  await writeFile(
    path.join(directory, 'openbox.xml'),
    '<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew>' +
      '<followMouse>no</followMouse></focus><desktops><number>1</number></desktops>' +
      '<menu><file>no-test-menu.xml</file></menu></openbox_config>\n',
    { mode: 0o600 },
  );
  return directory;
}

export async function runIsolatedDisplay(args, env = process.env) {
  if (!args.length) throw new Error('A Node test script or arguments are required.');
  const tools = displayTools(env);
  const directory = await prepareDisplay();
  const started = Date.now();
  let status = 1;
  try {
    const command = ownedProcess(
      tools['xvfb-run'],
      [
        '-a',
        '-f',
        path.join(directory, 'Xauthority'),
        '-e',
        path.join(directory, 'xvfb.log'),
        '-s',
        '-screen 0 1440x900x24 -dpi 96 -nolisten tcp',
        tools['dbus-run-session'],
        `--dbus-daemon=${tools['dbus-daemon']}`,
        '--',
        process.execPath,
        script,
        '--session',
        directory,
        ...args,
      ],
      {
        env: {
          ...displayEnvironment(env, tools),
          XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
        },
      },
    );
    status = await command.done;
    return status;
  } finally {
    await rm(path.join(directory, 'Xauthority'), { force: true });
    await writeFile(
      path.join(directory, 'result.json'),
      `${JSON.stringify({ status, durationMs: Date.now() - started, authorityRemoved: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

export async function ensureTestDisplay() {
  if (displayMode() === 'visible') return;
  if (process.env.VS_OMP_TEST_DISPLAY_ACTIVE === '1') {
    assertPrivateSession(process.env);
    return;
  }
  process.exit(await runIsolatedDisplay(process.argv.slice(1)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const [mode, directory, ...args] = process.argv.slice(2);
  if (mode === '--ready') {
    await writeFile(path.join(directory, 'wm.ready'), 'ready\n', { mode: 0o600, flag: 'wx' });
  } else if (mode === '--session') {
    process.exitCode = await runSession(directory, args);
  } else {
    process.exitCode = await runIsolatedDisplay(process.argv.slice(2));
  }
}
