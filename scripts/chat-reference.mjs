import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { signalFile, killGroup } from './native-dialogs.mjs';
import { ensureTestDisplay } from './test-display.mjs';

await ensureTestDisplay();

async function captureReference(page, output, turns) {
  await page.getByRole('button', { name: 'Maximize Secondary Side Bar', exact: true }).click();
  const completed = page.getByText(/^Completed \d+ steps$/);
  if (await completed.isVisible()) await completed.click();
  const tables = await page.locator('.interactive-session table').evaluateAll((elements) =>
    elements.map((table) => {
      const cell = table.querySelector('th');
      const style = cell && table.ownerDocument.defaultView.getComputedStyle(cell);
      return {
        rows: table.rows.length,
        borderBottom: style?.borderBottom,
        borderRight: style?.borderRight,
        padding: style?.padding,
        borderCollapse: table.ownerDocument.defaultView.getComputedStyle(table).borderCollapse,
      };
    }),
  );
  await writeFile(path.join(output, 'native-tables.json'), JSON.stringify(tables), { mode: 0o600 });
  for (const width of [600, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(output, `native-${width}.png`) });
  }
  const inventory = await page
    .locator('textarea, [contenteditable="true"], [role="textbox"], [role="button"], button')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        tag: element.tagName,
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        text: element.textContent?.slice(0, 100),
      })),
    );
  await writeFile(path.join(output, 'native-controls.json'), JSON.stringify(inventory, null, 2));
  const result = { populated: true, fixture: true, harness: 'Local', turns, inferenceRequests: 0 };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
}

async function probeAgent(page, output, ready) {
  await page.screenshot({ path: path.join(output, 'native-agent-ready.png') });
  const completed = signalFile(`${ready}.agent-result.json`);
  await page.locator('.interactive-input-part .monaco-editor').click();
  await page.keyboard.insertText('Return the public Agent catalog marker. Do not execute tools.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  const state = JSON.parse(
    await completed.catch(async (error) => {
      await page.screenshot({ path: path.join(output, 'native-agent-failure.png') });
      throw error;
    }),
  );
  assert.equal(state.requests, 1);
  await page
    .locator('.interactive-session .rendered-markdown')
    .filter({ hasText: 'PUBLIC_AGENT_CATALOG_ONLY' })
    .last()
    .waitFor();
  await writeFile(
    path.join(output, 'native-agent-tools.json'),
    await readFile(`${ready}.agent-tools.json`),
    { mode: 0o600 },
  );
  await page.screenshot({ path: path.join(output, 'native-agent-catalog.png') });
  const result = {
    fixture: true,
    harness: 'Local',
    scriptedRequests: 1,
    toolCalls: 0,
    inferenceRequests: 0,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify(result));
}

async function inspectReference(userData, output, ready, prompts) {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(15000);
    await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
    await page.getByText('Open Chat', { exact: true }).click();
    await page.locator('.interactive-session').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Copilot', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'native-harness-picker.png') });
    await writeFile(
      path.join(output, 'native-harness-picker.txt'),
      await page.locator('body').innerText(),
    );
    const local = page.getByText('Local', { exact: true });
    if (!(await local.isVisible())) {
      const result = {
        populated: false,
        blocked: 'Local is not exposed in the clean session target picker.',
        inferenceRequests: 0,
      };
      await writeFile(path.join(output, 'result.json'), JSON.stringify(result));
      console.log(JSON.stringify(result));
      return;
    }
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Local', exact: true }).waitFor();
    const models = page.getByText('Models', { exact: true });
    if (await models.isVisible()) {
      await models.click();
      await page.getByText('Recorded Fixture Only', { exact: true }).click();
    }
    await page
      .getByRole('button', { name: 'Models, Recorded Fixture Only', exact: true })
      .waitFor({ state: 'visible' });
    if (process.env.VS_OMP_REFERENCE_AGENT_PROBE === 'catalog')
      return await probeAgent(page, output, ready);
    const mode = page.getByRole('button', { name: 'Agent', exact: true });
    if (await mode.isVisible()) await mode.click();
    await page.screenshot({ path: path.join(output, 'native-mode-picker.png') });
    await writeFile(
      path.join(output, 'native-mode-picker.txt'),
      await page.locator('body').innerText(),
    );
    const ask = page.getByText('Ask', { exact: true });
    if (await ask.isVisible()) await ask.click();
    else await page.keyboard.press('Escape');
    for (const [index, prompt] of prompts.entries()) {
      const completed = signalFile(`${ready}.turn-${index + 1}.json`);
      await page.locator('.interactive-input-part .monaco-editor').click();
      await page.keyboard.insertText('@parity ' + prompt);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      assert.equal(JSON.parse(await completed).modelRequests, 0);
    }
    await writeFile(path.join(output, 'native-tools.json'), await readFile(`${ready}.tools.json`), {
      mode: 0o600,
    });
    await captureReference(page, output, prompts.length);
  } finally {
    await browser.close();
  }
}

const chat = path.resolve(process.env.VS_OMP_REFERENCE_CHAT ?? '');
assert.ok(process.env.VS_OMP_REFERENCE_CHAT, 'Select an actual bounded test-chat record.');
const output = await mkdtemp(path.resolve('reports', 'chat-reference-'));
await chmod(output, 0o700);
console.log(`Native reference evidence directory: ${output}`);
const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-chat-reference-'));
const userData = path.join(directory, 'user-data');
const workspace = path.join(directory, 'workspace');
await mkdir(userData);
await mkdir(workspace);
const ready = path.join(directory, 'ready.json');
const readySignal = signalFile(ready);
const child = spawn(
  process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
  [
    workspace,
    '--new-window',
    '--no-sandbox',
    '--disable-gpu',
    '--password-store=basic',
    ...(process.env.VS_OMP_REFERENCE_AGENT_PROBE === 'catalog' ? [] : ['--disable-extensions']),
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
    '--extensionDevelopmentPath',
    path.resolve('dist/test/chat-reference'),
  ],
  {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      VS_OMP_REFERENCE_CHAT: chat,
      VS_OMP_REFERENCE_READY: ready,
    },
  },
);
const exited = once(child, 'exit');
let diagnostics = '';
const capture = (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-16384);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
const deadline = setTimeout(() => killGroup(child, 'SIGKILL'), 45000);
try {
  await Promise.race([
    readySignal,
    exited.then(([code]) => {
      throw new Error(`Reference fixture exited early (${code}).`);
    }),
  ]);
  const status = JSON.parse(await readFile(ready, 'utf8'));
  assert.equal(status.ready, true);
  await inspectReference(userData, output, ready, status.prompts);
  console.log(`Native reference evidence: ${output}`);
} catch (error) {
  await writeFile(path.join(output, 'diagnostics.log'), diagnostics);
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
  await rm(directory, { recursive: true, force: true });
}
