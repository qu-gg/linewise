import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { approvalFrame, driveChatQuestions, signalFile } from './native-dialogs.mjs';
import { driveInstalledOnboarding, driveOnboarding } from './native-onboarding.mjs';
import { driveInlineReview } from './native-inline.mjs';

async function capture(target, output, name) {
  const image = path.join(output, `${name}.png`);
  await target.screenshot({ path: image });
  await chmod(image, 0o600);
}

async function tablePresentation(frame) {
  const snapshot = await frame.waitForFunction(() => {
    const element = [...globalThis.document.querySelectorAll('.markdown table')].at(-1);
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    const tableStyle = globalThis.getComputedStyle(element);
    if (!tableStyle.borderTopWidth) return;
    const headerStyle = globalThis.getComputedStyle(element.querySelector('th'));
    const bodyStyle = globalThis.getComputedStyle(element.querySelector('td'));
    return {
      border: tableStyle.borderTopWidth,
      collapse: tableStyle.borderCollapse,
      headerRight: headerStyle.borderRightWidth,
      bodyBottom: bodyStyle.borderBottomWidth,
      color: bodyStyle.borderBottomColor,
      padding: bodyStyle.padding,
      rows: element.querySelectorAll('tr').length,
      overflow:
        globalThis.document.documentElement.scrollWidth >
        globalThis.document.documentElement.clientWidth + 1,
    };
  });
  const presentation = await snapshot.jsonValue();
  await snapshot.dispose();
  return presentation;
}

async function driveQuickContext(page, output, file) {
  const frame = await approvalFrame(page, '.context-offer');
  const attached = frame.locator('[data-action="removeAttachment"]');
  assert.equal(await attached.count(), 0);
  await capture(page, output, 'context-offer');
  await frame.locator('[data-action="attachOffer"]').click();
  await attached.waitFor({ state: 'visible' });
  assert.equal(await attached.count(), 1);
  await attached.click();
  await attached.waitFor({ state: 'hidden' });
  await frame.locator('[data-action="dismissOffer"]').click();
  await frame.locator('.context-offer').waitFor({ state: 'hidden' });
  for (const entry of ['explorer', 'editor']) {
    if (entry === 'explorer')
      await page.getByRole('treeitem', { name: file, exact: true }).click({ button: 'right' });
    else {
      await page.getByRole('tab', { name: new RegExp(file.replace('.', '\\.')) }).click();
      await page
        .locator('.editor-group-container.active .monaco-editor .view-lines')
        .first()
        .click({ button: 'right' });
    }
    const command = page.getByRole('menuitem', { name: /Add File as Context to Linewise/ });
    await command.waitFor({ state: 'visible' });
    await capture(page, output, `context-${entry}-menu`);
    await command.click();
    await attached.waitFor({ state: 'visible' });
    assert.equal(await attached.count(), 1);
    await attached.click();
    await attached.waitFor({ state: 'hidden' });
  }
}

async function driveContext(page, workspace, output) {
  const ready = JSON.parse(
    await signalFile(path.join(workspace, 'native-ux-context-ready.json'), 120000),
  );
  await driveQuickContext(page, output, ready.file);
  await page
    .getByRole('tab', { name: new RegExp(ready.file.replace('.', '\\.')) })
    .click({ button: 'right' });
  const command = page.getByRole('menuitem', { name: /Add File as Context to Linewise/ });
  await command.waitFor({ state: 'visible' });
  await capture(page, output, 'context-menu');
  await command.click();
  const frame = await approvalFrame(page, '[data-action="removeAttachment"]');
  await frame.locator('[data-action="removeAttachment"]').waitFor({ state: 'visible' });
  await capture(page, output, 'context-attached');
  await writeFile(path.join(workspace, 'native-ux-context-done'), 'done', { mode: 0o600 });
  await signalFile(path.join(workspace, 'native-ux-tables-ready'));
  const table = frame.locator('.markdown table').last();
  await table.getByRole('columnheader', { name: 'Format', exact: true }).waitFor();
  const presentation = await tablePresentation(frame);
  await writeFile(path.join(output, 'table.json'), JSON.stringify(presentation), { mode: 0o600 });
  assert.equal(presentation.border, '1px');
  assert.equal(presentation.collapse, 'separate');
  assert.equal(presentation.headerRight, '1px');
  assert.equal(presentation.bodyBottom, '1px');
  assert.notEqual(presentation.color, 'rgba(0, 0, 0, 0)');
  assert.equal(presentation.padding, '4px 6px');
  assert.equal(presentation.rows, 3);
  assert.equal(presentation.overflow, false);
  await capture(page, output, 'chat-table');
  await writeFile(path.join(workspace, 'native-ux-tables-checked'), 'checked', { mode: 0o600 });
}

async function workbenchCommand(page, label) {
  await page.keyboard.press('F1');
  const picker = page.locator('.quick-input-widget');
  await picker.locator('input').fill(`>${label}`);
  await picker.getByRole('option').filter({ hasText: label }).click();
  await picker.waitFor({ state: 'hidden' });
}

const reloadWebviews = (page) => workbenchCommand(page, 'Developer: Reload Webviews');

async function retireQuestion(page, frame, scenario) {
  if (['cancel', 'dismiss', 'stale'].includes(scenario)) {
    await frame
      .locator('.question-card[data-question-id]')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
  } else if (scenario === 'stop') {
    await frame.getByRole('button', { name: 'Stop', exact: true }).press('Enter');
  } else {
    await reloadWebviews(page);
  }
}

async function driveQuestionRetirement(page, workspace, output) {
  for (const scenario of ['cancel', 'stop', 'reload', 'dismiss', 'stale']) {
    const name = `native-ux-question-${scenario}`;
    await signalFile(path.join(workspace, `${name}-ready`));
    const frame = await approvalFrame(page, '.question-card[data-question-id]');
    if (['dismiss', 'stale'].includes(scenario))
      await page
        .getByRole('button', { name: 'Answer Questions', exact: true })
        .last()
        .waitFor({ state: 'visible' });
    else
      assert.equal(
        await page
          .locator('.notifications-toasts')
          .getByRole('button', { name: 'Answer Questions', exact: true })
          .count(),
        0,
      );
    await frame.locator('#question-option-0').check();
    await frame.locator('#question-custom').fill('NATIVE_UNSUBMITTED_ANSWER');
    await frame.locator('#prompt').fill('NATIVE_RETIRED_QUESTION_DRAFT');
    await writeFile(path.join(workspace, `${name}-held`), 'held', { mode: 0o600 });
    await signalFile(path.join(workspace, `${name}-held-checked`));
    if (scenario === 'dismiss') {
      const notification = page
        .locator('.notifications-toasts .notification-list-item')
        .filter({ hasText: 'Linewise: Has questions' });
      await notification.hover();
      const actions = await notification.locator('a, button').evaluateAll((elements) =>
        elements.map((element) => ({
          role: element.getAttribute('role'),
          label: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          visible: Boolean(element.getClientRects().length),
        })),
      );
      await writeFile(path.join(output, 'dismissal-actions.json'), JSON.stringify(actions), {
        mode: 0o600,
      });
      await notification.getByRole('button', { name: /^Clear Notification/ }).click();
      await writeFile(path.join(workspace, `${name}-dismissed`), 'dismissed', { mode: 0o600 });
      await signalFile(path.join(workspace, `${name}-dismissed-checked`));
      assert.equal(await frame.locator('.question-card[data-question-id]').count(), 1);
    }
    await retireQuestion(page, frame, scenario);
    await signalFile(path.join(workspace, `${name}-done`));
    const current = await approvalFrame(page, '#prompt');
    await current.locator('.question-card[data-question-id]').waitFor({ state: 'hidden' });
    assert.equal(await current.locator('#prompt').inputValue(), 'NATIVE_RETIRED_QUESTION_DRAFT');
    if (scenario === 'stale') {
      await page.getByRole('tab', { name: /context-entry\.ts/ }).click();
      await writeFile(path.join(workspace, `${name}-center-ready`), 'ready', { mode: 0o600 });
      await page
        .locator('.notifications-center')
        .getByRole('button', { name: 'Answer Questions', exact: true })
        .last()
        .click();
      assert.equal(await current.locator('.question-card[data-question-id]').count(), 0);
      assert.equal(await current.evaluate(() => globalThis.document.hasFocus()), false);
      assert.equal(await current.locator('#prompt').inputValue(), 'NATIVE_RETIRED_QUESTION_DRAFT');
    }
    await capture(page, output, `question-${scenario}-retired`);
    await writeFile(path.join(workspace, `${name}-visible`), 'visible', { mode: 0o600 });
  }
}

async function driveAttention(page, workspace, output) {
  const prefix = path.join(workspace, 'native-ux-attention');
  await signalFile(`${prefix}-ready`);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('tab', { name: /context-entry\.ts/ }).click();
  await writeFile(`${prefix}-go`, 'go', { mode: 0o600 });
  const frame = await approvalFrame(page, '.approval-card[data-approval-id]');
  assert.equal(
    await page
      .locator('.notifications-toasts')
      .getByRole('button', { name: 'Review Approval', exact: true })
      .count(),
    0,
  );
  await workbenchCommand(page, 'Notifications: Show Notifications');
  const approval = page
    .locator('.notifications-center')
    .getByRole('button', { name: 'Review Approval', exact: true });
  await approval.waitFor({ state: 'visible' });
  await writeFile(`${prefix}-held`, 'held', { mode: 0o600 });
  await signalFile(`${prefix}-held-checked`);
  await capture(page, output, 'approval-attention');
  await approval.click();
  try {
    await frame.waitForFunction(() =>
      globalThis.document.activeElement?.classList.contains('approval-card'),
    );
  } catch (error) {
    const focus = await frame.evaluate(() => ({
      activeTag: globalThis.document.activeElement?.tagName,
      activeId: globalThis.document.activeElement?.id,
      activeClass: globalThis.document.activeElement?.className,
      focused: globalThis.document.hasFocus(),
      approval: Boolean(globalThis.document.querySelector('.approval-card[data-approval-id]')),
    }));
    await writeFile(path.join(output, 'approval-focus-failure.json'), JSON.stringify(focus), {
      mode: 0o600,
    });
    await capture(page, output, 'approval-focus-failure');
    throw error;
  }
  await writeFile(`${prefix}-focused`, 'focused', { mode: 0o600 });
  await signalFile(`${prefix}-focused-checked`);
  await capture(page, output, 'approval-revealed');
  await frame.locator('[data-approval="allow"]').press('Enter');
  await signalFile(`${prefix}-done`);
  const finished = page.getByRole('button', { name: 'Open Session', exact: true }).last();
  await finished.waitFor({ state: 'visible' });
  await capture(page, output, 'finished-attention');
  await page.getByRole('tab', { name: /context-entry\.ts/ }).click();
  await finished.click();
  await frame.waitForFunction(() => globalThis.document.activeElement?.id === 'prompt');
  await writeFile(`${prefix}-finished-checked`, 'checked', { mode: 0o600 });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function managerCheckpoint(workspace, stage) {
  const name = path.join(workspace, `native-ux-manager-${stage}`);
  await writeFile(name, stage, { mode: 0o600 });
  await signalFile(`${name}-checked`);
}

async function renameAndArchive(frame, workspace, id) {
  await frame.locator('#session-search').fill('NO_MATCHING_NATIVE_SESSION');
  assert.equal(await frame.locator('.session-row').count(), 0);
  await frame.locator('#session-search').fill('');
  const row = frame.locator(`.session-row:has([data-id="${id}"])`);
  await row.getByRole('button', { name: 'Rename Session', exact: true }).click();
  await frame.locator('#session-title').fill('Native UX named session');
  await frame.locator('#session-title').press('Enter');
  await frame.locator('#session-title').waitFor({ state: 'hidden' });
  assert.equal(await row.locator('strong').innerText(), 'Native UX named session');
  await managerCheckpoint(workspace, 'renamed');
  await row.getByRole('button', { name: 'Archive Session', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  await managerCheckpoint(workspace, 'archived');
}

async function driveManager(page, workspace, output) {
  const { id } = JSON.parse(await signalFile(path.join(workspace, 'native-ux-manager-ready.json')));
  let frame = await approvalFrame(page, '#prompt');
  const draft = 'NATIVE_MANAGER_UNSENT_DRAFT';
  await frame.locator('#prompt').fill(draft);
  await frame.locator('[data-action="sessions"]').click();
  await frame.locator('.session-manager').waitFor({ state: 'visible' });
  await frame.waitForFunction(() => globalThis.document.activeElement?.id === 'session-search');
  assert.equal(
    await frame
      .locator('#session-search')
      .evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await renameAndArchive(frame, workspace, id);
  await frame.locator('[data-session="filters"]').click();
  await frame.locator('#session-show-archived').check();
  await frame.locator('#session-search').fill('Native UX named session');
  await reloadWebviews(page);
  frame = await approvalFrame(page, '.session-manager');
  assert.equal(await frame.locator('#session-search').inputValue(), 'Native UX named session');
  await frame.locator('[data-session="filters"]').click();
  assert.equal(await frame.locator('#session-show-archived').isChecked(), true);
  await frame.locator('[data-session="filters"]').click();
  const row = frame.locator(`.session-row:has([data-id="${id}"])`);
  await row.waitFor({ state: 'visible' });
  await managerCheckpoint(workspace, 'recreated');
  await capture(page, output, 'manager-archived');
  await row.locator('.session-open').click();
  await managerCheckpoint(workspace, 'opened');
  await frame.waitForFunction(
    (expected) => globalThis.document.querySelector('#prompt')?.value === expected,
    draft,
  );
  assert.equal(await frame.locator('#prompt').inputValue(), draft);
  await frame.locator('[data-action="sessions"]').click();
  await row.getByRole('button', { name: 'Restore Session', exact: true }).click();
  await frame.locator('[data-group="archived"] .session-row').waitFor({ state: 'hidden' });
  await managerCheckpoint(workspace, 'restored');
  await row.waitFor({ state: 'visible' });
  await capture(page, output, 'manager-restored');
  await row.getByRole('button', { name: 'Resume Session', exact: true }).click();
  await frame.locator('.session-manager').waitFor({ state: 'hidden' });
  await frame.waitForFunction(
    () => globalThis.document.querySelector('.host-status')?.textContent === 'Local',
  );
  await managerCheckpoint(workspace, 'resumed');
  await frame.waitForFunction(
    (expected) => globalThis.document.querySelector('#prompt')?.value === expected,
    draft,
  );
  assert.equal(await frame.locator('#prompt').inputValue(), draft);
}

async function driveUsage(page, workspace, output) {
  const format = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  for (const stage of ['manual', 'failure', 'cancel', 'automatic']) {
    const name = path.join(workspace, `native-ux-usage-${stage}`);
    const usage = JSON.parse(await signalFile(`${name}-ready.json`));
    const percent = Math.min(100, Math.round((usage.used / usage.size) * 100));
    const frame = await approvalFrame(page, '#context-toggle');
    await frame.waitForFunction(
      (expected) =>
        globalThis.document.querySelector('#context-toggle')?.textContent.trim() === `${expected}%`,
      percent,
    );
    await frame.getByRole('button', { name: 'Session Context', exact: true }).press('Enter');
    const dialog = frame.getByRole('dialog', { name: 'Session Info', exact: true });
    await dialog.waitFor({ state: 'visible' });
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        parentLeft: parent.left,
        parentRight: parent.right,
        width: globalThis.document.documentElement.clientWidth,
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1);
    assert.ok(bounds.left >= bounds.parentLeft - 1 && bounds.right <= bounds.parentRight + 1);
    assert.equal(bounds.overflow, false);
    assert.equal(
      await dialog.locator('.context-numbers').innerText(),
      `${format.format(usage.used)} / ${format.format(usage.size)} tokens\n${percent}%`,
    );
    assert.equal(Number(await dialog.getByRole('progressbar').getAttribute('max')), usage.size);
    assert.equal(
      Number(await dialog.getByRole('progressbar').getAttribute('value')),
      Math.min(usage.used, usage.size),
    );
    assert.equal(await dialog.locator('.context-note').count(), usage.stale ? 1 : 0);
    if (usage.stale)
      assert.match(await dialog.locator('.context-note').innerText(), /Last reported usage/);
    await capture(page, output, `context-${stage}`);
    await dialog.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await writeFile(`${name}-checked`, 'checked', { mode: 0o600 });
  }
}

function reviewSampleOriginal() {
  return [
    "export function formatHeader(value = '') {",
    '  return `Header: ${value}`;',
    '}',
    '',
    'export const sampleRows = [',
    ...'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
      .split(' ')
      .map((word) => `  '${word}',`),
    '];',
    '',
    "export function formatFooter(value = '') {",
    '  return `Footer: ${value}`;',
    '}',
    '',
  ].join('\n');
}

export async function driveDocsCapture(userData, workspace, ready, done) {
  assert.ok(ready && done, 'Docs capture requires explicit ready and done signals.');
  await signalFile(ready, 120000);
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await mkdir('reports/native-ux', { recursive: true, mode: 0o700 });
  const output = await mkdtemp('reports/native-ux/docs-');
  await chmod(output, 0o700);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(30000);
    const frame = await approvalFrame(page, '#prompt');
    await writeFile(path.join(workspace, 'review-sample.ts'), reviewSampleOriginal(), {
      mode: 0o600,
    });
    await frame
      .locator('#prompt')
      .fill('Change Header: and Footer: to uppercase in review-sample.ts.');
    await frame.locator('#prompt').press('Enter');
    await frame.locator('.assistant-answer').last().waitFor({ state: 'visible' });
    await frame.locator('.file-review').last().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Maximize Secondary Side Bar', exact: true }).click();
    await page.setViewportSize({ width: 600, height: 900 });
    const toast = page.locator('.notifications-toasts .notification-list-item').last();
    if (await toast.isVisible()) {
      await toast.hover();
      await toast.getByRole('button', { name: /^Clear Notification/ }).click();
    }
    await frame.locator('#prompt').fill('');
    await page.waitForTimeout(500);
    await capture(page, output, 'comparison-600');
    await writeFile(done, 'done', { mode: 0o600 });
    console.log(`PASS: native docs comparison capture: ${output}`);
  } finally {
    await browser.close();
  }
}

export async function driveNativeUX(userData, workspace, installed = false) {
  const active = await signalFile(path.join(userData, 'DevToolsActivePort'));
  const port = Number(active.split('\n')[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await mkdir('reports/native-ux', { recursive: true, mode: 0o700 });
  const output = await mkdtemp('reports/native-ux/run-');
  await chmod(output, 0o700);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.setDefaultTimeout(15000);
    await driveOnboarding(page, workspace, output, capture);
    if (installed) {
      await driveInstalledOnboarding(page, workspace, output, capture);
      console.log(
        `PASS: registry-installed package public UI onboarding and model controls: ${output}`,
      );
      return;
    }
    await driveContext(page, workspace, output);
    await driveChatQuestions(page, workspace, output, capture);
    await driveQuestionRetirement(page, workspace, output);
    await driveAttention(page, workspace, output);
    await driveManager(page, workspace, output);
    await driveInlineReview(page, workspace, output, capture);
    await driveUsage(page, workspace, output);
    await writeFile(
      path.join(output, 'result.json'),
      JSON.stringify({
        contextMenu: true,
        onboarding: true,
        questions: true,
        questionAttention: true,
        sessionManager: true,
        inlineReview: true,
        tables: true,
        compactionUsage: true,
        inferenceRequests: 0,
      }),
      { mode: 0o600 },
    );
    console.log(
      `PASS: native context menu, mixed questions, attention and session manager interaction: ${output}`,
    );
  } catch (error) {
    await writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify({ passed: false, error: String(error) }),
      { mode: 0o600 },
    );
    console.error(`Native UX driver failed: ${output}`, error);
    throw error;
  } finally {
    await browser.close();
  }
}
