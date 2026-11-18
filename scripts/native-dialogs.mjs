import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

function signalFile(target) {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(target), (_event, fileName) => {
      if (fileName === path.basename(target)) void inspect();
    });
    const timer = setTimeout(
      () => finish(new Error(`Native UI signal missing: ${path.basename(target)}`)),
      30_000,
    );
    function finish(error, content) {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(content);
    }
    async function inspect() {
      try {
        const content = await readFile(target, 'utf8');
        if (content) finish(undefined, content);
      } catch (error) {
        if (error.code !== 'ENOENT') finish(error);
      }
    }
    watcher.once('error', finish);
    void inspect();
  });
}

async function approvalFrame(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator('.approval-card').isVisible()) return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new Error('Production approval card was not visible in the workbench');
}

async function chooseCommand(page, workspace, scenario) {
  const frame = await approvalFrame(page);
  const card = frame.locator('.approval-card');
  await card.filter({ hasText: `native-${scenario}.txt` }).waitFor({ state: 'visible' });
  await card.locator('[data-approval="details"]').click();
  const content = await card.innerText();
  for (const expected of [
    workspace,
    `native-${scenario}.txt`,
    'Executable:',
    'Arguments:',
    'Working directory:',
    'Environment overrides:',
    'VS_OMP_NATIVE_CASE',
    '\\u202eINVISIBLE',
    'not sandboxed',
    'Keep/Discard',
    'conversation rewind',
    'Source Control',
  ])
    assert.ok(content.includes(expected), `Command approval must show ${expected}`);
  const tokens = await card.evaluate((element) => {
    const styles = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      radius: styles.borderRadius,
      spacing: styles.getPropertyValue('--vscode-spacing-size80'),
    };
  });
  assert.ok(tokens.spacing.trim(), 'Native Webview must receive size tokens');
  assert.notEqual(tokens.radius, '0px');
  await page.screenshot({ path: path.join('reports', 'native-dialogs', `${scenario}.png`) });
  if (scenario === 'cancel-late') {
    const cancelled = signalFile(path.join(workspace, 'native-cancelled'));
    await writeFile(path.join(workspace, 'native-cancel'), 'cancel');
    await cancelled;
  } else {
    if (['escape', 'menu'].includes(scenario)) {
      await card.locator('[data-approval="menu"]').click();
      await page.screenshot({
        path: path.join('reports', 'native-dialogs', `${scenario}-options.png`),
      });
      await page.keyboard.press('Escape');
      assert.equal(await card.isVisible(), true);
      assert.equal(await frame.locator('.approval-menu').isVisible(), false);
    }
    const choice = scenario.endsWith('-running') || scenario === 'approve' ? 'allow' : 'skip';
    await card.locator(`[data-approval="${choice}"]`).click();
  }
  await card.waitFor({ state: 'hidden' });
  console.log(`PASS: native inline approval ${scenario} driven through the real workbench.`);
}

async function choosePermissions(page) {
  const picker = page.locator('.quick-input-widget');
  try {
    await picker.getByText('Allow All Except Restrictions', { exact: true }).click();
  } catch (error) {
    console.error('Native policy dialog state:', await page.getByRole('dialog').allTextContents());
    throw error;
  }
  const confirmation = page
    .getByRole('dialog')
    .filter({ hasText: 'Allow commands without confirmation for this connection?' });
  await confirmation.getByRole('button', { name: 'Enable Allow All', exact: true }).click();
  const frame = await approvalFrame(page);
  const asking = frame.locator('.approval-card');
  assert.match(await asking.innerText(), /printf NATIVE_TERMINAL_OUTPUT/);
  await page.screenshot({
    path: path.join('reports', 'native-dialogs', 'policy-ask-under-all.png'),
  });
  await asking.locator('[data-approval="skip"]').click();
  await picker.getByText('Command Rules', { exact: true }).click();
  console.log(
    'PASS: real permission picker confirms elevation, preserves ask exceptions and revokes Allow All.',
  );
}

async function driveNativeDialogs(userData, workspace) {
  const content = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(content.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    assert.ok(context, 'The isolated VS Code browser context must exist.');
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(15_000);
    await page.waitForURL(/workbench\.html/);
    await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
    console.log('PASS: Playwright reaches only the disposable VS Code workbench.');
    await mkdir(path.join('reports', 'native-dialogs'), { recursive: true });
    await choosePermissions(page);
    for (const scenario of [
      'reject',
      'escape',
      'menu',
      'approve',
      'reject-again',
      'cancel-late',
      'stop-running',
      'disconnect-running',
      'exit-running',
    ])
      await chooseCommand(page, workspace, scenario);
    await writeFile(path.join(workspace, 'native-ui-done'), 'done');
  } finally {
    await browser.close();
  }
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function runNativeDialogs(directory) {
  const workspace = path.join(directory, 'native-workspace');
  const userData = path.join(directory, 'native-user-data');
  await mkdir(workspace);
  await mkdir(userData);
  const resultPath = path.join(workspace, 'native-results.json');
  const resultReady = signalFile(resultPath);
  const child = spawn(
    process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    [
      workspace,
      '--new-window',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir',
      userData,
      '--extensions-dir',
      path.join(directory, 'native-extensions'),
      '--extensionDevelopmentPath',
      path.join(process.cwd(), 'dist/test/native-ui'),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        VS_OMP_NATIVE_UI_RESULTS: resultPath,
        VS_OMP_NATIVE_EXTENSION_ROOT: process.cwd(),
      },
    },
  );
  const exited = once(child, 'exit');
  let diagnostics = '';
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16_384);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const deadline = setTimeout(() => killGroup(child, 'SIGKILL'), 45_000);
  try {
    await Promise.race([
      Promise.all([
        driveNativeDialogs(userData, workspace),
        resultReady.then((result) => {
          const status = JSON.parse(result);
          assert.equal(status.ok, true, status.error);
        }),
      ]),
      exited.then(([code]) => {
        throw new Error(`Native UI window exited early (${code}).`);
      }),
    ]);
  } catch (error) {
    process.stderr.write(diagnostics);
    throw error;
  } finally {
    clearTimeout(deadline);
    killGroup(child, 'SIGTERM');
    const force = setTimeout(() => killGroup(child, 'SIGKILL'), 1500);
    try {
      await exited;
    } finally {
      clearTimeout(force);
      killGroup(child, 'SIGKILL');
    }
  }
}
