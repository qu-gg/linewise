import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { signalFile } from './native-dialogs.mjs';
import { copyPtyRuntime } from './pty-runtime.mjs';
import { copyBrowserRuntime } from './browser-runtime.mjs';
import { ensureTestDisplay } from './test-display.mjs';

await ensureTestDisplay();
const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-terminal-probe-'));
const reports = path.resolve('reports/terminal-probe');
await mkdir(reports, { recursive: true, mode: 0o700 });
const report = await mkdtemp(path.join(reports, 'run-'));
await chmod(report, 0o700);
const workspace = path.join(directory, 'workspace');
const extension = path.join(directory, 'extension');
const userData = path.join(directory, 'user-data');

async function prepare() {
  for (const folder of [workspace, extension, path.join(userData, 'User')])
    await mkdir(folder, { recursive: true });
  await copyPtyRuntime();
  await copyBrowserRuntime();
  await cp('dist/pty', path.join(extension, 'pty'), { recursive: true });
  await cp('dist/playwright', path.join(extension, 'playwright'), { recursive: true });
  await writeFile(
    path.join(extension, 'package.json'),
    JSON.stringify({
      name: 'omp-terminal-probe',
      publisher: 'vs-omp-fixture',
      version: '0.0.0',
      engines: { vscode: '^1.146.0' },
    }),
  );
  await writeFile(
    path.join(userData, 'User/settings.json'),
    JSON.stringify({
      'terminal.integrated.shellIntegration.enabled': true,
      'terminal.integrated.enablePersistentSessions': false,
      'terminal.integrated.gpuAcceleration': 'off',
      'terminal.integrated.suggest.enabled': false,
      'chat.disableAIFeatures': true,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
    }),
  );
  await build({
    entryPoints: ['src/test/terminal-probe.integration.ts'],
    outfile: path.join(extension, 'test.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    external: ['vscode'],
    plugins: [
      {
        name: 'owned-pty-runtime',
        setup(builder) {
          builder.onResolve({ filter: /^node-pty$/ }, () => ({
            path: './pty/index.cjs',
            external: true,
          }));
          builder.onResolve({ filter: /^playwright-core$/ }, () => ({
            path: './playwright/index.js',
            external: true,
          }));
        },
      },
    ],
  });
}

async function keyboardCase(page, scenario) {
  if (scenario.startsWith('production-')) {
    await signalFile(path.join(workspace, `keyboard-${scenario}-background-ready`));
    if (await page.locator('.part.panel').isVisible())
      throw new Error('Background terminal opened the panel.');
    await writeFile(path.join(workspace, `keyboard-${scenario}-background-checked`), 'checked', {
      mode: 0o600,
    });
  }
  const request = JSON.parse(
    await signalFile(path.join(workspace, `keyboard-${scenario}-ready.json`)),
  );
  const button = page.getByRole('button', { name: request.button, exact: true });
  await button.waitFor({ state: 'visible' });
  console.log(`Keyboard fixture ${scenario}: ready.`);
  const early = scenario.endsWith('early');
  if (early) {
    await button.click();
    const confirmed = path.join(workspace, `keyboard-${scenario}-confirmed`);
    if (scenario.startsWith('production-')) await writeFile(confirmed, 'clicked', { mode: 0o600 });
    else await signalFile(confirmed);
  }
  const terminal = request.terminal ?? 'OMP T-04 disposable execution';
  if (!/^OMP (?:[a-f0-9]{8}|T-04 disposable execution)$/.test(terminal))
    throw new Error('Unexpected fixture terminal identity.');
  const input = page.locator('.terminal-wrapper.active').getByRole('textbox', {
    name: new RegExp(`^Terminal \\d+, ${terminal}\\b`),
  });
  await input.focus();
  await input.pressSequentially(request.value);
  await input.press('Enter');
  console.log(`Keyboard fixture ${scenario}: submitted.`);
  if (!early) {
    await signalFile(path.join(workspace, `keyboard-${scenario}-finished`));
    await button.click();
  }
  console.log(`Keyboard fixture ${scenario}: confirmed.`);
}

async function notificationCase(page, action) {
  const request = JSON.parse(
    await signalFile(path.join(workspace, `production-${action}-ready.json`)),
  );
  if (!/^OMP [a-f0-9]{8}$/.test(request.terminal))
    throw new Error('Unexpected cancellation terminal identity.');
  const notification = page
    .locator('.notification-list-item')
    .filter({ hasText: `${request.terminal}: Waiting for User` });
  await notification.waitFor({ state: 'visible' });
  if (action === 'cancel')
    await notification.getByRole('button', { name: 'Cancel Command', exact: true }).click();
  else {
    await notification.hover();
    await notification.getByRole('button', { name: /^Clear Notification\b/ }).click();
  }
  console.log(`PASS: actual production ${action} notification control exercised.`);
}

async function keyboardInput() {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid disposable workbench debug port.');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(20000);
    await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
    for (const scenario of ['success', 'failure', 'early']) await keyboardCase(page, scenario);
    for (const scenario of ['production-success', 'production-failure', 'production-early'])
      await keyboardCase(page, scenario);
    for (const scenario of ['installed-success', 'installed-failure'])
      await keyboardCase(page, scenario);
    for (const action of ['cancel', 'dismiss']) await notificationCase(page, action);
  } finally {
    await browser.close();
  }
}

try {
  await prepare();
  const testing = runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(extension, 'test.cjs'),
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      VS_OMP_TERMINAL_PROBE_REPORT: path.join(report, 'result.json'),
      VS_OMP_TERMINAL_PROBE_HOME: workspace,
      VS_OMP_NATIVE_EXTENSION_ROOT: process.cwd(),
    },
    launchArgs: [
      workspace,
      '--no-sandbox',
      '--disable-gpu',
      '--password-store=basic',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir',
      userData,
      '--shared-data-dir',
      path.join(directory, 'shared-data'),
      '--extensions-dir',
      path.join(directory, 'extensions'),
    ],
  });
  const results = await Promise.allSettled([testing, keyboardInput()]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
  console.log(`Terminal feasibility evidence: ${path.relative(process.cwd(), report)}`);
} catch (error) {
  await writeFile(path.join(report, 'failure.json'), JSON.stringify({ error: String(error) }), {
    mode: 0o600,
  });
  console.error(`Terminal feasibility failure retained: ${report}`);
  throw error;
} finally {
  await rm(directory, { recursive: true, force: true });
}
