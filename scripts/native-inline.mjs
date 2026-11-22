import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvalFrame, signalFile } from './native-dialogs.mjs';

async function checkpoint(workspace, stage) {
  await writeFile(path.join(workspace, `native-ux-inline-${stage}`), stage, { mode: 0o600 });
  await signalFile(path.join(workspace, `native-ux-inline-${stage}-checked`));
}

async function narrowReview(page, inline, output, capture) {
  const original = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  await page.setViewportSize({ width: 900, height: 768 });
  await inline.locator('.review-controls').first().waitFor({ state: 'visible' });
  const boxes = await inline.locator('.review-controls:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        bottom: box.bottom,
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      };
    }),
  );
  assert.ok(boxes.length > 0);
  assert.ok(
    boxes.every((box) => box.left >= 0 && box.right <= box.width && box.bottom <= box.height),
  );
  await controlsClearCode(inline);
  await capture(page, output, 'inline-review-narrow');
  await page.setViewportSize(original);
}

async function controlsClearCode(inline) {
  const clear = await inline.locator('body').evaluate((body) => {
    const rows = [...body.querySelectorAll('.view-lines .view-line, .review-deleted > div')].map(
      (element) => element.getBoundingClientRect(),
    );
    return [...body.querySelectorAll('.review-controls:not([hidden])')].every((element) => {
      const control = element.getBoundingClientRect();
      return rows.every((row) => control.bottom <= row.top || control.top >= row.bottom);
    });
  });
  assert.ok(clear, 'Floating review controls must not cover source or deleted lines');
}

export async function driveInlineReview(page, workspace, output, capture) {
  const { id, hunks } = JSON.parse(
    await signalFile(path.join(workspace, 'native-ux-inline-ready.json')),
  );
  const frame = await approvalFrame(page, `[data-id="${id}"][data-action="review"]`);
  assert.equal(await frame.locator('.inline-diff, .review-hunks, [data-hunk-id]').count(), 0);
  await capture(page, output, 'inline-review-chat');
  const review = frame.locator(`[data-id="${id}"][data-action="review"]`);
  await review.click();
  await page.getByRole('tab', { name: /review-sample\.ts/ }).waitFor({ state: 'visible' });
  await review.click();
  const inline = await approvalFrame(page, `[data-hunk-id="${hunks[0]}"]`);
  assert.equal(await page.locator('.monaco-diff-editor').count(), 0);
  assert.equal(await inline.locator('.review-controls').count(), 2);
  await inline
    .locator('.review-deleted .review-old-code')
    .filter({ hasText: 'Header:' })
    .waitFor({ state: 'visible' });
  const keep = inline
    .locator(`[data-hunk-id="${hunks[0]}"]`)
    .getByRole('button', { name: 'Keep change', exact: true });
  await keep.waitFor({ state: 'visible' });
  await controlsClearCode(inline);
  await capture(page, output, 'inline-review-editor');
  await narrowReview(page, inline, output, capture);
  await checkpoint(workspace, 'previewed');
  await keep.click();
  await frame.waitForFunction(
    (id) =>
      globalThis.document.querySelector(`.file-review:has([data-id="${id}"]) .file-counts`)
        ?.textContent === '+1-1',
    id,
  );
  await checkpoint(workspace, 'kept');
  await inline
    .locator('.review-deleted .review-old-code')
    .filter({ hasText: 'Header:' })
    .waitFor({ state: 'hidden' });
  assert.equal(await inline.locator('.review-controls').count(), 1);
  await inline
    .locator('.view-lines .view-line')
    .filter({ hasText: /return\s+`HEADER:/ })
    .waitFor({ state: 'visible' });
  await capture(page, output, 'inline-review-after-keep');
  await inline.locator('.monaco-editor').hover();
  await page.mouse.wheel(0, 500);
  const undo = inline
    .locator(`[data-hunk-id="${hunks[1]}"]`)
    .getByRole('button', { name: 'Undo change', exact: true });
  await undo.waitFor({ state: 'visible' });
  await capture(page, output, 'inline-review-footer-controls');
  await undo.focus();
  await page.keyboard.press('Enter');
  await review.waitFor({ state: 'hidden' });
  await checkpoint(workspace, 'discarded');
  await page
    .locator('.editor-group-container.active .view-line')
    .filter({ hasText: /return\s+`Footer:/ })
    .waitFor({ state: 'visible' });
  await capture(page, output, 'inline-review-after-discard');
}
