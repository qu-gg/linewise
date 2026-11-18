import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

function signalFile(target) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const watcher = watch(path.dirname(target), (_event, file) => {
      if (file === path.basename(target)) void inspect();
    });
    const timer = setTimeout(() => finish(new Error(`Crash signal missing: ${target}`)), 45000);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(value);
    }
    async function inspect() {
      try {
        finish(undefined, JSON.parse(await readFile(target, 'utf8')));
      } catch (error) {
        if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) finish(error);
      }
    }
    watcher.once('error', finish);
    void inspect();
  });
}

function kill(pid, group = false, signal = 'SIGKILL') {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function restartHost(page) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.fill('>Developer: Restart Extension Host');
  await page.getByText('Developer: Restart Extension Host', { exact: true }).waitFor();
  await input.press('Enter');
}

function launchCrashHost(current, workspace, userData, stage) {
  return spawn(
    process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    [
      workspace,
      '--new-window',
      '--no-sandbox',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir',
      userData,
      '--extensions-dir',
      path.join(current, 'extensions'),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        VS_OMP_CRASH_DIRECTORY: current,
        VS_OMP_CRASH_STAGE: stage,
        VS_OMP_NATIVE_EXTENSION_ROOT: process.cwd(),
        VS_OMP_TEST_FIXTURE: path.join(process.cwd(), 'scripts/history-fixture.mjs'),
        VS_OMP_FIXTURE_CONTEXT: path.join(current, 'provider-context.json'),
        VS_OMP_FIXTURE_PID: path.join(current, 'omp.pid'),
      },
    },
  );
}

async function crashCase(directory, stage) {
  const current = path.join(directory, stage);
  const workspace = path.join(current, 'workspace');
  const userData = path.join(current, 'user-data');
  await mkdir(workspace, { recursive: true });
  await mkdir(userData);
  await cp(
    path.join(process.cwd(), 'dist/test/crash-host'),
    path.join(current, 'extensions', 'vs-omp-fixture.vs-omp-crash-test-0.0.0'),
    { recursive: true },
  );
  await writeFile(path.join(current, 'phase'), 'prepare');
  const ready = signalFile(path.join(current, 'ready.json'));
  const result = signalFile(path.join(current, 'result.json'));
  const child = launchCrashHost(current, workspace, userData, stage);
  const exited = once(child, 'exit');
  let diagnostics = '';
  child.stdout.on('data', (data) => {
    diagnostics = (diagnostics + data).slice(-16000);
  });
  child.stderr.on('data', (data) => {
    diagnostics = (diagnostics + data).slice(-16000);
  });
  let browser;
  try {
    const hit = await Promise.race([
      ready,
      result.then((value) => {
        throw new Error(value.error || 'Crash case did not stop');
      }),
    ]);
    const portText = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(portText.split('\n')[0])}`);
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(15000);
    await writeFile(path.join(current, 'phase'), 'recover');
    kill(hit.host);
    kill(hit.omp);
    const recovered = await Promise.race([result, restartHost(page).then(() => result)]);
    assert.equal(recovered.ok, true, recovered.error);
    console.log(`PASS: native SIGKILL at ${stage} reopens without replay or file/review changes.`);
  } catch (error) {
    process.stderr.write(diagnostics);
    throw error;
  } finally {
    await browser?.close();
    kill(child.pid, true, 'SIGTERM');
    const force = setTimeout(() => kill(child.pid, true), 1500);
    await exited;
    clearTimeout(force);
    kill(child.pid, true);
  }
}

const allStages = [
  'archive',
  'intent-before',
  'intent',
  'navigation',
  'navigated',
  'verified',
  'rewound',
  'replacement',
  'submitted',
  'final',
  'fork-save',
  'fork-selected',
];

export async function runHistoryCrashes(stages = allStages) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-crashes-'));
  const results = [];
  try {
    for (const stage of stages) {
      assert.ok(allStages.includes(stage), `Unknown crash stage: ${stage}`);
      await crashCase(directory, stage);
      results.push({ stage, signal: 'SIGKILL', ok: true });
    }
    await mkdir('reports', { recursive: true });
    await writeFile('reports/history-crashes.json', JSON.stringify({ results }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runHistoryCrashes(process.env.VS_OMP_CRASH_STAGES?.split(','));
