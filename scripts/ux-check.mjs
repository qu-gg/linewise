import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { checkPresentationStates, checkSessionStates } from './ux-states.mjs';

async function seed(page, theme) {
  await page.evaluate((theme) => {
    const { document, window } = globalThis;
    document.body.className = theme;
    Object.assign(globalThis.fixtureState, {
      sessionId: 'ux-fixture',
      session: 'Review output format',
      busy: false,
      queued: [],
      approval: undefined,
      approvalCount: 0,
      attachments: [],
      changes: [],
      contextOffer: {
        id: 'offer',
        uri: 'file:///workspace/src/components/output-format.ts',
        label: 'src/components/output-format-with-a-long-file-name.ts',
      },
      turns: [
        {
          id: 'table',
          prompt: 'Compare output formats',
          status: 'completed',
          startedAt: 1,
          endedAt: 1001,
          blocks: [
            {
              id: 'answer',
              kind: 'text',
              text: '| Format | State |\n| --- | --- |\n| **JSON** | Ready |\n| Text | Available |',
            },
          ],
        },
      ],
    });
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
  }, theme);
  await page.locator('.markdown table').waitFor();
  await page.locator('.context-offer').waitFor();
}

async function screenshot(page, directory, name) {
  const filename = path.join(directory, `${name}.png`);
  await page.screenshot({ path: filename });
  await chmod(filename, 0o600);
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const { document, window } = globalThis;
    const table = document.querySelector('.markdown table');
    const cell = table.querySelector('th');
    const style = cell.ownerDocument.defaultView.getComputedStyle(cell);
    const stop = document.querySelector('[data-action="cancel"]');
    return {
      width: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      cells: table.querySelectorAll('th,td').length,
      border: style.borderBottomWidth,
      stopVisible: !stop || stop.getBoundingClientRect().bottom <= window.innerHeight,
      actionsDirection:
        document.querySelector('.question-card footer') &&
        window.getComputedStyle(document.querySelector('.question-card footer')).flexDirection,
    };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.cells, 6);
  assert.equal(layout.border, '1px');
  assert.equal(layout.stopVisible, true);
  if (layout.actionsDirection) assert.equal(layout.actionsDirection, 'row');
  return layout;
}

async function checkInlineReview(page, directory, name) {
  await page.evaluate(() => {
    const { window } = globalThis;
    globalThis.fixtureState.changes = [
      {
        id: 'inline-review',
        name: 'src/output.ts',
        kind: 'edit',
        state: 'pending',
        added: 1,
        removed: 1,
        hunks: [
          {
            id: 'inline-hunk',
            oldStart: 12,
            newStart: 12,
            oldLines: 3,
            newLines: 3,
            preview: [
              ' export function output() {',
              '-  return null;',
              `+  return JSON.stringify('${'long output value '.repeat(40)}');`,
              ' }',
            ],
            truncated: false,
          },
        ],
      },
    ];
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
  });
  const row = page.locator('.file-review:has([data-id="inline-review"])');
  await row.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inline-diff, .review-hunks, [data-hunk-id]').count(), 0);
  const layout = await page.evaluate(() => {
    const { document, window } = globalThis;
    const row = document.querySelector('.file-review');
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      withinViewport: row.getBoundingClientRect().right <= window.innerWidth,
      counts: row.querySelector('.file-counts').textContent,
      added: window.getComputedStyle(row.querySelector('.added')).color,
      removed: window.getComputedStyle(row.querySelector('.removed')).color,
    };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.withinViewport, true);
  assert.equal(layout.counts, '+1-1');
  assert.notEqual(layout.added, layout.removed);
  await screenshot(page, directory, `${name}-file-review`);
  const review = row.locator('[data-action="review"]');
  await review.focus();
  await review.press('Enter');
  await row.getByRole('button', { name: 'Keep File', exact: true }).click();
  const actions = await page.evaluate(() =>
    globalThis.messages.filter((message) => message.id === 'inline-review'),
  );
  assert.deepEqual(actions, [
    { v: 1, type: 'review', id: 'inline-review' },
    { v: 1, type: 'keep', id: 'inline-review' },
  ]);
}

async function checkQuestions(page) {
  await page.evaluate(() => {
    const { window } = globalThis;
    Object.assign(globalThis.fixtureState, {
      busy: true,
      contextOffer: undefined,
      question: {
        id: 'question',
        questions: [
          {
            header: 'Format',
            question: 'Which output formats should be included?',
            multiSelect: true,
            allowFreeformInput: true,
            options: [
              {
                label: 'JSON',
                description: 'Structured output with exact values',
                recommended: true,
              },
              { label: 'Text', description: 'Readable plain text output' },
            ],
          },
        ],
      },
    });
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
  });
  await page.locator('.question-card').waitFor();
  assert.equal(await page.locator('.question-choice input:checked').count(), 0);
}

async function checkQuestionResults(page, directory, name) {
  await page.evaluate(() => {
    const { window } = globalThis;
    globalThis.fixtureState.question = undefined;
    globalThis.fixtureState.turns.push({
      id: 'answered-question',
      prompt: 'Choose output formats',
      status: 'completed',
      startedAt: 1,
      endedAt: 1001,
      blocks: [
        {
          id: 'answered-tool',
          kind: 'tool',
          title: 'ask',
          status: 'completed',
          text: JSON.stringify({
            status: 'answered',
            answers: { Format: { selected: ['JSON'], freeText: 'Include a compact summary' } },
          }),
        },
        {
          id: 'cancelled-tool',
          kind: 'tool',
          title: 'ask',
          status: 'completed',
          text: JSON.stringify({ status: 'cancelled', answers: {} }),
        },
      ],
    });
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
  });
  await page.getByRole('region', { name: 'Answers Submitted', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Questions Cancelled', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.question-result button, .question-result input, .question-result textarea')
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth,
    ),
    false,
  );
  await screenshot(page, directory, `${name}-questions-completed`);
}

async function checkSessions(page, directory, name) {
  await page.evaluate(() => {
    const { window } = globalThis;
    Object.assign(globalThis.fixtureState, {
      sessionIds: ['ux-fixture', 'archived-fixture'],
      sessions: [
        {
          id: 'ux-fixture',
          title: 'Review output formats and preserve a very long session title',
          root: 'file:///workspace/components/output-format',
          archived: false,
          active: true,
          pendingReview: true,
        },
        {
          id: 'archived-fixture',
          title: 'Archived format investigation',
          root: 'file:///workspace/archived',
          archived: true,
          active: false,
        },
      ],
    });
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
    window.postMessage({ v: 1, type: 'showSessions' }, window.location.origin);
  });
  await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Archive Session', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible(), true);
  const bounds = await page.evaluate(() => {
    const { document, window } = globalThis;
    const stop = document.querySelector('[data-action="cancel"]').getBoundingClientRect();
    const title = document.querySelector('.session-open strong').getBoundingClientRect();
    const actions = document.querySelector('.session-row-actions').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      stopVisible: stop.top >= 0 && stop.bottom <= window.innerHeight,
      rowOverlap: title.right > actions.left,
    };
  });
  assert.deepEqual(bounds, { overflow: false, stopVisible: true, rowOverlap: false });
  await screenshot(page, directory, `${name}-sessions-recent`);
  await page.getByRole('tab', { name: 'Recent', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Restore Session', exact: true }).waitFor();
  await screenshot(page, directory, `${name}-sessions-archived`);
  await page.evaluate(() => {
    const { window } = globalThis;
    Object.assign(globalThis.fixtureState, { busy: false, question: undefined });
    window.postMessage(
      { v: 1, type: 'state', state: globalThis.fixtureState },
      window.location.origin,
    );
  });
  await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
  const restored = await page.evaluate(() =>
    globalThis.messages.filter((message) => message.type === 'restoreSession'),
  );
  assert.deepEqual(restored, [{ v: 1, type: 'restoreSession', id: 'archived-fixture' }]);
  await page.getByRole('searchbox', { name: 'Search Sessions', exact: true }).press('Escape');
  await page.getByRole('textbox', { name: 'Message OMP', exact: true }).waitFor();
}

async function checkContextPanel(page, directory, name) {
  for (const stale of [false, true]) {
    await page.evaluate((stale) => {
      globalThis.fixtureState.context = { used: 17027, size: 128000, stale };
      globalThis.window.postMessage(
        { v: 1, type: 'state', state: globalThis.fixtureState },
        globalThis.window.location.origin,
      );
    }, stale);
    await page.getByRole('button', { name: 'Session Context', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Session Info', exact: true });
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
    assert.equal(await dialog.locator('.context-note').count(), stale ? 1 : 0);
    await screenshot(page, directory, `${name}-context-${stale ? 'stale' : 'fresh'}`);
    await dialog.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
}

async function inspect(browser, url, directory, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await seed(page, theme);
    const layout = await checkLayout(page);
    await screenshot(page, directory, `${theme}-${width}-context`);
    await checkInlineReview(page, directory, `${theme}-${width}`);
    await checkQuestions(page);
    await checkLayout(page);
    await screenshot(page, directory, `${theme}-${width}-questions`);
    await page.locator('#question-option-0').check();
    await page.locator('#question-custom').fill('Include a compact summary');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.locator('.question-review').waitFor();
    await screenshot(page, directory, `${theme}-${width}-review`);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    const answers = await page.evaluate(() =>
      globalThis.messages.filter((message) => message.type === 'questionAnswer'),
    );
    assert.deepEqual(answers, [
      {
        v: 1,
        type: 'questionAnswer',
        id: 'question',
        answers: [{ selected: ['JSON'], freeText: 'Include a compact summary' }],
      },
    ]);
    await checkQuestionResults(page, directory, `${theme}-${width}`);
    await checkContextPanel(page, directory, `${theme}-${width}`);
    await checkSessions(page, directory, `${theme}-${width}`);
    await checkPresentationStates(page, directory, `${theme}-${width}`, screenshot);
    await checkSessionStates(page, directory, `${theme}-${width}`, screenshot);
    assert.deepEqual(errors, []);
    return {
      theme,
      ...layout,
      inlineReview: true,
      questionSubmitted: true,
      sessionManager: true,
      rendererErrors: 0,
    };
  } finally {
    await page.close();
  }
}

process.env.PORT = '0';
const { server } = await import('./preview.mjs');
if (!server.listening) await once(server, 'listening');
await mkdir('reports/ux-preview', { recursive: true, mode: 0o700 });
const directory = await mkdtemp('reports/ux-preview/run-');
await chmod(directory, 0o700);
let browser;
try {
  browser = await chromium.launch({ executablePath: '/opt/brave.com/brave/brave', headless: true });
  const results = [];
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const width of [320, 600, 1100])
    for (const theme of ['', 'light', 'contrast'])
      results.push(await inspect(browser, url, directory, width, theme || 'dark'));
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({ fixture: true, inferenceRequests: 0, results }, null, 2),
    { mode: 0o600 },
  );
  console.log(`UX fixture passed ${results.length} theme/viewport cases: ${directory}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
