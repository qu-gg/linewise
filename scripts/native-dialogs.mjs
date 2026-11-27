import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

export function signalFile(target, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(target), (_event, fileName) => {
      if (fileName === path.basename(target)) void inspect();
    });
    const timer = setTimeout(
      () => finish(new Error(`Native UI signal missing: ${path.basename(target)}`)),
      timeout,
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

export async function approvalFrame(page, selector = '.approval-card') {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator(selector).isVisible()) return frame;
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

async function chooseYolo(page, picker, frame) {
  for (const enabled of [false, true]) {
    await picker.getByText('YOLO Commands', { exact: true }).click();
    const dialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Enable YOLO command execution for this connection?' });
    assert.match(await dialog.innerText(), /without an OS sandbox/);
    assert.match(await dialog.innerText(), /cannot reliably detect/);
    if (enabled)
      await page.screenshot({ path: path.join('reports', 'native-dialogs', 'yolo-warning.png') });
    await dialog
      .getByRole('button', { name: enabled ? 'Enable YOLO' : 'Cancel', exact: true })
      .click();
  }
  const asking = frame.locator('.approval-card');
  await asking.waitFor({ state: 'visible' });
  assert.match(await asking.innerText(), /printf NATIVE_TERMINAL_OUTPUT/);
  await page.screenshot({
    path: path.join('reports', 'native-dialogs', 'policy-ask-under-yolo.png'),
  });
  await asking.locator('[data-approval="skip"]').click();
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
  await chooseYolo(page, picker, frame);
  await picker.getByText('Command Rules', { exact: true }).click();
  console.log(
    'PASS: real permission picker confirms Allow All/YOLO elevation, preserves ask exceptions and revokes elevated permissions.',
  );
}

export async function chooseQuestions(
  page,
  workspace,
  screenshot = path.join('reports', 'native-dialogs', 'questions-many.png'),
) {
  const picker = page.locator('.quick-input-widget');
  await picker.getByText('Parity Choice', { exact: true }).waitFor({ state: 'visible' });
  await picker.getByText('JSON', { exact: true }).click();
  await picker.getByText('Parity Many', { exact: true }).waitFor({ state: 'visible' });
  await picker.getByText('Diagnostics', { exact: true }).click();
  await picker.getByText('Tests', { exact: true }).click();
  await page.screenshot({ path: screenshot });
  await picker.getByRole('button', { name: 'OK', exact: true }).click();
  await picker.getByText('Parity Text', { exact: true }).waitFor({ state: 'visible' });
  await picker.locator('input').fill('Exact native user answer');
  await page.keyboard.press('Enter');
  await picker.getByText('Parity Dismiss', { exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await picker.getByText('Parity Stop', { exact: true }).waitFor({ state: 'visible' });
  await writeFile(path.join(workspace, 'native-question-stop'), 'stop');
  await picker.waitFor({ state: 'hidden' });
  console.log('PASS: real native question controls exercised without model inference.');
}

export async function driveChatQuestions(page, workspace, output, capture) {
  await signalFile(path.join(workspace, 'native-ux-questions-ready.json'));
  await page.getByRole('tab', { name: /context-entry\.ts/ }).click();
  await writeFile(path.join(workspace, 'native-ux-questions-go'), 'go', { mode: 0o600 });
  const attention = page.getByRole('button', { name: 'Answer Questions', exact: true });
  await attention.waitFor({ state: 'visible' });
  assert.equal(await attention.count(), 1, 'Question notification must not be duplicated.');
  await capture(page, output, 'question-attention');
  await attention.click();
  const frame = await approvalFrame(page, '.question-card[data-question-id]');
  await frame.waitForFunction(() =>
    globalThis.document.activeElement?.classList.contains('question-card'),
  );
  assert.equal(await frame.locator('.question-choice input:checked').count(), 0);
  assert.equal(await page.locator('.quick-input-widget').isVisible(), false);
  await capture(page, output, 'question-card');
  await page.keyboard.press('Tab');
  assert.equal(
    await frame
      .locator('#question-option-0')
      .evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  assert.equal(
    await frame
      .locator('#question-custom')
      .evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await page.keyboard.type('Include a short summary');
  await frame.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await frame.locator('#question-option-0').press('ArrowDown');
  assert.equal(await frame.locator('#question-option-1').isChecked(), true);
  await frame.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await frame.locator('#question-custom').press('P');
  await page.keyboard.type('reserve exact values');
  await frame.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await frame.locator('.question-review').waitFor({ state: 'visible' });
  await capture(page, output, 'question-review');
  await frame.getByRole('button', { name: 'Submit', exact: true }).press('Enter');
  await signalFile(path.join(workspace, 'native-ux-questions-done'));
  await frame.getByRole('region', { name: 'Answers Submitted', exact: true }).waitFor();
  assert.equal(await frame.locator('.question-result input, .question-result button').count(), 0);
  assert.equal(await frame.locator('.question-card[data-question-id]').count(), 0);
  await capture(page, output, 'question-submitted');
  await writeFile(path.join(workspace, 'native-ux-questions-visible'), 'visible', { mode: 0o600 });
}

export async function driveTerminalControls(userData, workspace) {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(20000);
    const ready = JSON.parse(
      await signalFile(path.join(workspace, 'native-terminal-controls-ready.json'), 120000),
    );
    assert.match(ready.terminal, /^OMP [a-f0-9]{8}$/);
    const frame = await approvalFrame(page, '[aria-label="OMP Terminals"]');
    const button = frame.getByRole('button', { name: 'OMP Terminals', exact: true });
    assert.equal(await button.isEnabled(), true);
    const picker = page.locator('.quick-input-widget');
    await button.click();
    const owned = picker.getByRole('option').filter({ hasText: ready.terminal });
    await owned.waitFor({ state: 'visible' });
    assert.equal(await picker.getByRole('option').count(), 1);
    const pickerImage = path.join('reports', 'native-dialogs', 'owned-terminal-picker.png');
    await page.screenshot({ path: pickerImage });
    await chmod(pickerImage, 0o600);
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden' });
    await button.click();
    await owned.waitFor({ state: 'visible' });
    await page.keyboard.press('Enter');
    await picker.getByText('Reveal', { exact: true }).waitFor({ state: 'visible' });
    assert.ok(
      (await picker.getByRole('option').allTextContents()).some((text) => text.includes('Stop')),
    );
    await page.keyboard.press('Enter');
    await picker.waitFor({ state: 'hidden' });
    const input = page
      .locator('.terminal-wrapper.active')
      .getByRole('textbox', { name: new RegExp(`^Terminal \\d+, ${ready.terminal}\\b`) });
    await input.waitFor({ state: 'attached' });
    await page.waitForFunction(
      (element) => element.ownerDocument.activeElement === element,
      await input.elementHandle(),
    );
    assert.equal(
      await input.evaluate((element) => element.ownerDocument.activeElement === element),
      true,
    );
    const revealImage = path.join('reports', 'native-dialogs', 'owned-terminal-reveal.png');
    await page.screenshot({ path: revealImage });
    await chmod(revealImage, 0o600);
    await writeFile(path.join(workspace, 'native-terminal-controls-done'), 'done', { mode: 0o600 });
    console.log(
      'PASS: actual terminal toolbar and keyboard picker isolate owned handles, cancel/reopen and Reveal focus without input.',
    );
  } finally {
    await browser.close();
  }
}

export async function driveLiveQuestions(userData, workspace, report, timeout) {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(timeout);
    await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
    if (['mixed-questions', 'mixed-session'].includes(process.env.VS_OMP_LIVE_CASE))
      await driveChatQuestions(page, workspace, report, async (target, output, name) => {
        const image = `${output}.${name}.png`;
        await target.screenshot({ path: image });
        await chmod(image, 0o600);
      });
    else await chooseQuestions(page, workspace, `${report}.questions.png`);
  } finally {
    await browser.close();
  }
}

export async function driveLiveTerminals(userData, workspace, report, timeout) {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(timeout);
    for (const index of [0, 1]) {
      const prefix = path.join(workspace, `live-terminal-${index}`);
      const request = JSON.parse(await signalFile(`${prefix}-ready.json`, timeout));
      assert.match(request.terminal, /^OMP [a-f0-9]{8}$/);
      const button = page.getByRole('button', { name: 'Resume Agent', exact: true });
      await button.waitFor({ state: 'visible' });
      const input = page.locator('.terminal-wrapper.active').getByRole('textbox', {
        name: new RegExp(`^Terminal \\d+, ${request.terminal}\\b`),
      });
      await input.focus();
      await input.pressSequentially(request.value);
      await input.press('Enter');
      await signalFile(`${prefix}-finished`, timeout);
      const held = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(held.requests.length, request.requests);
      await button.click();
      console.log(`PASS: native human driver confirmed live terminal stage ${index}.`);
    }
  } finally {
    await browser.close();
  }
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
    page.setDefaultTimeout(30_000);
    await page.waitForURL(/workbench\.html/);
    await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
    console.log('PASS: Playwright reaches only the disposable VS Code workbench.');
    await mkdir(path.join('reports', 'native-dialogs'), { recursive: true });
    await chooseQuestions(page, workspace);
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

export function killGroup(child, signal) {
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
  const resultReady = signalFile(path.join(workspace, 'native-ui-ready')).then(() =>
    signalFile(resultPath),
  );
  const child = spawn(
    process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    [
      workspace,
      '--new-window',
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
      path.join(directory, 'native-shared-data'),
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
