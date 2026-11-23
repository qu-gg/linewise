import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { approvalFrame, signalFile } from './native-dialogs.mjs';
import { ensureTestDisplay } from './test-display.mjs';

await ensureTestDisplay();

function kill(pid, group = false, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function command(page, label) {
  await page.bringToFront();
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.fill(`>${label}`);
  await page.getByText(label, { exact: true }).waitFor();
  await input.press('Enter');
}

async function trustWorkspace(page) {
  await page.locator('.monaco-workbench').waitFor();
  await page.locator('.part.banner').getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Trust', exact: true }).click();
  await page.keyboard.press('Escape');
}

function workerProgram(directory, privacy) {
  const file = (name) => JSON.stringify(path.join(directory, name));
  const start = `const fs=require('node:fs');fs.writeFileSync(${file('worker.pid')},String(process.pid));process.stdout.write('READY');`;
  if (!privacy) return `${start}process.stdin.resume();`;
  return `${start}process.stdin.once('data',data=>{const value=data.toString().trim();process.stdout.write(value,()=>{fs.writeFileSync(${file('worker-finished')},'finished');process.exit(value===fs.readFileSync(${file('expected-input')},'utf8')?0:1);});});`;
}

async function prepare(directory, scenario) {
  const workspace = path.join(directory, 'workspace');
  const userData = path.join(directory, 'user-data');
  const extension = path.join(
    directory,
    'extensions',
    'vs-omp-fixture.vs-omp-terminal-lifecycle-0.0.0',
  );
  await mkdir(workspace);
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await cp('dist/test/terminal-lifecycle', extension, { recursive: true });
  await cp('dist/pty', path.join(directory, 'pty'), { recursive: true });
  await cp('dist/playwright', path.join(directory, 'playwright'), { recursive: true });
  const program = workerProgram(directory, scenario.startsWith('privacy-'));
  const worker = path.join(directory, 'worker.cjs');
  await writeFile(worker, program, { mode: 0o600 });
  await writeFile(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'all',
      'files.hotExit': 'onExitAndWindowClose',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'chat.disableAIFeatures': true,
      'omp.notifications.focus': scenario === 'mixed-attention' ? 'always' : 'background',
      'security.workspace.trust.startupPrompt': 'never',
      'workbench.colorTheme':
        scenario === 'privacy-success'
          ? 'Default Light Modern'
          : scenario === 'privacy-failure'
            ? 'Default High Contrast'
            : 'Default Dark Modern',
      'window.zoomLevel': scenario === 'privacy-failure' ? 1 : 0,
      'omp.permissions.commandRules': [
        { command: ['node', worker], match: 'exact', action: 'allow' },
        { command: ['printf', 'OTHER_SAFE_WORK'], match: 'exact', action: 'allow' },
      ],
    }),
  );
  await writeFile(path.join(directory, 'phase'), 'prepare');
  const command = `node ${JSON.stringify(worker)}`;
  return { workspace, userData, command, scenario };
}

function launch(directory, fixture) {
  return spawn(
    process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    [
      fixture.workspace,
      '--new-window',
      '--no-sandbox',
      '--disable-gpu',
      '--password-store=basic',
      '--skip-welcome',
      '--skip-release-notes',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir',
      fixture.userData,
      '--shared-data-dir',
      path.join(directory, 'shared-data'),
      '--extensions-dir',
      path.join(directory, 'extensions'),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        VS_OMP_TERMINAL_LIFECYCLE: directory,
        VS_OMP_TERMINAL_CASE: fixture.scenario,
        VS_OMP_NATIVE_EXTENSION_ROOT: process.cwd(),
        VS_OMP_TEST_FIXTURE: path.resolve('scripts/terminal-handoff-fixture.mjs'),
        VS_OMP_FIXTURE_CONTEXT: path.join(directory, 'provider-context.json'),
        VS_OMP_FIXTURE_PID: path.join(directory, 'omp.pid'),
        VS_OMP_FIXTURE_HANDOFF: JSON.stringify({ command: fixture.command }),
      },
    },
  );
}

async function assertStopped(hit) {
  for (const pid of [hit.worker, hit.omp]) {
    assert.ok(Number.isInteger(pid) && pid > 1);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
}

async function transition(page, scenario, directory) {
  await writeFile(path.join(directory, 'phase'), 'recover');
  if (scenario === 'reload') await command(page, 'Developer: Reload Window');
  else {
    await command(page, 'Workspaces: Manage Workspace Trust');
    await page.getByRole('button', { name: "Don't Trust", exact: true }).click();
    await page.getByText('You are in Restricted Mode', { exact: false }).first().waitFor();
    await page.screenshot({ path: path.join(directory, 'restricted.png') });
    await chmod(path.join(directory, 'restricted.png'), 0o600);
  }
}

async function scanPrivate(directory, value) {
  let files = 0;
  let native = 0;
  let outputLogs = 0;
  const inspect = async (target) => {
    const bytes = await readFile(target);
    assert.equal(
      bytes.includes(Buffer.from(value)),
      false,
      `Sensitive input leaked into ${target}`,
    );
    files++;
    if (target.endsWith('.jsonl')) native++;
    if (/output_logging[^/]*\/[^/]*Linewise[^/]*\.log$/.test(target)) outputLogs++;
  };
  const visit = async (root) => {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) await inspect(target);
      else assert.fail(`Unexpected non-file privacy artifact: ${target}`);
    }
  };
  for (const root of ['storage', 'user-data/logs']) await visit(path.join(directory, root));
  for (const name of ['provider-context.json', 'chat-state.json', 'export.json'])
    await inspect(path.join(directory, name));
  const exported = JSON.parse(await readFile(path.join(directory, 'export.json'), 'utf8'));
  assert.equal(exported.format, 'vs-omp-session');
  assert.ok(exported.artifacts.some((artifact) => artifact.name.endsWith('.jsonl')));
  assert.ok(native > 0);
  assert.ok(outputLogs > 0, 'Actual Linewise output-channel logs must be included.');
  return { files, native, outputLogs };
}

async function inspectControls(page, terminal, directory) {
  const frame = await approvalFrame(page, 'button[aria-label="OMP Terminals"]');
  const button = frame.getByRole('button', { name: 'OMP Terminals', exact: true });
  const viewport = page.viewportSize();
  for (const control of [
    button,
    page.getByRole('button', { name: 'Resume Agent', exact: true }),
    page.getByRole('button', { name: 'Cancel Command', exact: true }),
  ]) {
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= viewport.width + 1);
    assert.ok(bounds.y + bounds.height <= viewport.height + 1);
  }
  await button.focus();
  await button.press('Enter');
  const picker = page.locator('.quick-input-widget');
  await picker.getByText(terminal, { exact: true }).waitFor();
  assert.equal(await picker.getByRole('option').count(), 1);
  await page.screenshot({ path: path.join(directory, 'controls.png') });
  await chmod(path.join(directory, 'controls.png'), 0o600);
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  await frame
    .waitForFunction(
      (body) => body.ownerDocument.activeElement?.getAttribute('data-action') === 'terminals',
      await frame.locator('body').elementHandle(),
    )
    .catch(async (error) => {
      const focused = await frame.locator('body').evaluate((body) => {
        const active = body.ownerDocument.activeElement;
        return {
          tag: active?.tagName,
          id: active?.id,
          action: active?.getAttribute('data-action'),
          label: active?.getAttribute('aria-label'),
        };
      });
      await writeFile(path.join(directory, 'focus-before-input.json'), JSON.stringify(focused), {
        mode: 0o600,
      });
      throw error;
    });
  await writeFile(
    path.join(directory, 'controls.json'),
    JSON.stringify({
      viewport,
      ownedOptions: 1,
      keyboardActivation: true,
      focusRestored: true,
      controlsInBounds: true,
    }),
    { mode: 0o600 },
  );
  return frame;
}

async function privacyCase(page, hit, directory, scenario, result) {
  const viewport =
    scenario === 'privacy-cancel'
      ? { width: 1024, height: 768 }
      : scenario === 'privacy-failure'
        ? { width: 1200, height: 750 }
        : { width: 1440, height: 900 };
  await page.setViewportSize(viewport);
  const frame = await inspectControls(page, hit.terminal, directory);
  const value = `SYNTHETIC_${randomUUID()}`;
  await writeFile(
    path.join(directory, 'expected-input'),
    scenario === 'privacy-failure' ? randomUUID() : value,
    { mode: 0o600 },
  );
  const before = await readFile(path.join(directory, 'provider-context.json'), 'utf8');
  const input = page.locator('.terminal-wrapper.active').getByRole('textbox', {
    name: new RegExp(`^Terminal \\d+, ${hit.terminal}\\b`),
  });
  await input.focus();
  await input.pressSequentially(value);
  if (scenario !== 'privacy-cancel') {
    await input.press('Enter');
    await signalFile(path.join(directory, 'worker-finished'));
  }
  assert.equal(await readFile(path.join(directory, 'provider-context.json'), 'utf8'), before);
  await page
    .getByRole('button', {
      name: scenario === 'privacy-cancel' ? 'Cancel Command' : 'Resume Agent',
      exact: true,
    })
    .click();
  const outcome = JSON.parse(await result);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(
    outcome.theme,
    scenario === 'privacy-success' ? 1 : scenario === 'privacy-failure' ? 3 : 2,
  );
  assert.equal(outcome.zoom, scenario === 'privacy-failure' ? 1 : 0);
  assert.equal(
    (await frame.locator('body').innerText()).includes(value),
    false,
    'Chat DOM must exclude terminal input.',
  );
  const privacy = await scanPrivate(directory, value);
  await rm(path.join(directory, 'expected-input'));
  await writeFile(
    path.join(directory, 'privacy.json'),
    JSON.stringify({
      ...privacy,
      providerHeld: true,
      chatDomExcluded: true,
      screenshotsBeforeInputOnly: true,
    }),
    { mode: 0o600 },
  );
  console.log(
    `PASS: native ${scenario} excludes echoed input from chat/state/export/provider/transcripts/output/logs; controls checked before input. Evidence: ${directory}`,
  );
  return { ...outcome, privacy };
}

async function reportFailure(browser, directory, diagnostics, sensitive) {
  await writeFile(path.join(directory, 'diagnostics.log'), diagnostics, { mode: 0o600 });
  if (sensitive) {
    console.error(
      `Retained failed sensitive terminal fixture without input screenshots: ${directory}`,
    );
    return;
  }
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error('Owned lifecycle UI buttons:', await page.getByRole('button').allTextContents());
    const metadata = await page
      .locator('dialog, [role="dialog"], [inert], .quick-input-widget')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          tag: node.tagName,
          role: node.getAttribute('role'),
          label: node.getAttribute('aria-label'),
          inert: node.hasAttribute('inert'),
          text: node.textContent?.slice(0, 2048),
        })),
      );
    await writeFile(path.join(directory, 'ui-metadata.json'), JSON.stringify(metadata), {
      mode: 0o600,
    });
    await page.screenshot({ path: path.join(directory, 'failure.png') });
    await chmod(path.join(directory, 'failure.png'), 0o600);
  }
  console.error(`Retained failed terminal lifecycle fixture: ${directory}`);
}

async function mixedAttention(page, hit, directory, result) {
  const before = await readFile(path.join(directory, 'provider-context.json'), 'utf8');
  const stale = page.getByRole('button', { name: 'Open Session', exact: true });
  await stale.waitFor();
  assert.equal(await stale.count(), 1);
  await stale.click();
  assert.ok((await readFile(path.join(directory, 'provider-context.json'), 'utf8')) === before);
  await writeFile(path.join(directory, 'mixed-clicked'), 'clicked', { mode: 0o600 });
  await signalFile(path.join(directory, 'mixed-checked'));
  await page.keyboard.press('Escape');
  const frame = await approvalFrame(page, 'button[aria-label="OMP Terminals"]');
  await page.screenshot({ path: path.join(directory, 'mixed-held.png') });
  await chmod(path.join(directory, 'mixed-held.png'), 0o600);
  await frame.getByRole('button', { name: /^Stop/ }).click();
  const outcome = JSON.parse(await result);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.staleActionIgnored, true);
  assert.equal(await page.getByRole('button', { name: 'Open Session', exact: true }).count(), 0);
  assert.ok((await readFile(path.join(directory, 'provider-context.json'), 'utf8')) === before);
  await assertStopped(hit);
  await writeFile(
    path.join(directory, 'controls.json'),
    JSON.stringify({
      staleActions: 1,
      duplicateActions: false,
      falseCompletion: false,
      actualStop: true,
    }),
    { mode: 0o600 },
  );
  return { scenario: 'mixed-attention', ...outcome, processesStopped: true, directory };
}

async function interactiveCase(page, hit, directory, scenario, result) {
  if (scenario === 'mixed-attention') {
    const outcome = await mixedAttention(page, hit, directory, result);
    console.log(
      `PASS: native mixed terminal/stale attention/Stop preserves ownership and dirty review. Evidence: ${directory}`,
    );
    return outcome;
  }
  if (scenario.startsWith('privacy-')) {
    const outcome = await privacyCase(page, hit, directory, scenario, result);
    await assertStopped(hit);
    return { scenario, ...outcome, processesStopped: true, directory };
  }
}

async function lifecycleCase(scenario) {
  const reports = path.resolve('reports/terminal-lifecycle');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(reports, `${scenario}-`));
  const fixture = await prepare(directory, scenario);
  const ready = signalFile(path.join(directory, 'ready.json'), 60_000);
  const result = signalFile(path.join(directory, 'result.json'), 90_000);
  void ready.catch(() => {});
  void result.catch(() => {});
  const port = signalFile(path.join(fixture.userData, 'DevToolsActivePort'));
  const child = launch(directory, fixture);
  const exited = once(child, 'exit');
  let diagnostics = '';
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-32_768);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const deadline = setTimeout(() => kill(child.pid, true, 'SIGKILL'), 100_000);
  let browser;
  let hit;
  let stopped = false;
  try {
    const portText = await port;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(portText.split('\n')[0])}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(20_000);
    await trustWorkspace(page);
    await writeFile(path.join(directory, 'start'), 'start', { mode: 0o600 });
    hit = JSON.parse(
      await Promise.race([
        ready,
        result.then((text) => {
          throw new Error(JSON.parse(text).error || 'Lifecycle fixture did not hold.');
        }),
      ]),
    );
    assert.equal(hit.trusted, true);
    await page.getByRole('button', { name: 'Resume Agent', exact: true }).waitFor();
    const interactive = await interactiveCase(page, hit, directory, scenario, result);
    if (interactive) {
      stopped = true;
      return interactive;
    }
    await transition(page, scenario, directory);
    if (scenario === 'trust') {
      await assertStopped(hit);
      await page.getByRole('button', { name: 'Trust', exact: true }).click();
    }
    await writeFile(path.join(directory, 'recover'), 'recover', { mode: 0o600 });
    const outcome = JSON.parse(await result);
    assert.equal(outcome.ok, true, outcome.error);
    await assertStopped(hit);
    stopped = true;
    console.log(
      `PASS: native ${scenario} cancels PTY/OMP, preserves dirty review state and never replays queued work. Evidence: ${directory}`,
    );
    return { scenario, ...outcome, processesStopped: true, directory };
  } catch (error) {
    await reportFailure(browser, directory, diagnostics, scenario.startsWith('privacy-')).catch(
      (diagnosticError) => console.error('Lifecycle failure diagnostics:', String(diagnosticError)),
    );
    throw error;
  } finally {
    await browser?.close();
    kill(child.pid, true);
    const force = setTimeout(() => kill(child.pid, true, 'SIGKILL'), 1_500);
    await exited;
    clearTimeout(force);
    clearTimeout(deadline);
    kill(child.pid, true, 'SIGKILL');
    if (hit && !stopped) {
      kill(hit.worker, false, 'SIGKILL');
      kill(hit.omp, false, 'SIGKILL');
    }
  }
}

const allowed = [
  'reload',
  'trust',
  'privacy-success',
  'privacy-failure',
  'privacy-cancel',
  'mixed-attention',
];
const scenarios = process.argv[2] ? [process.argv[2]] : allowed;
for (const scenario of scenarios) assert.ok(allowed.includes(scenario));
const results = [];
for (const scenario of scenarios) results.push(await lifecycleCase(scenario));
await writeFile('reports/terminal-lifecycle/results.json', JSON.stringify({ results }, null, 2), {
  mode: 0o600,
});
