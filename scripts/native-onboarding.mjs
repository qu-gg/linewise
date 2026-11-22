import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvalFrame, signalFile } from './native-dialogs.mjs';

export async function driveOnboarding(page, workspace, output, capture) {
  for (const kind of ['missing', 'incompatible', 'auth']) {
    const { hint } = JSON.parse(
      await signalFile(path.join(workspace, `native-onboarding-${kind}.json`)),
    );
    const frame = await approvalFrame(page, '#prompt');
    const message = frame.getByText(hint, { exact: false }).first();
    await message.waitFor({ state: 'visible' });
    assert.ok((await message.innerText()).includes(hint));
    assert.equal(await frame.locator('.host-status').innerText(), 'Disconnected');
    await capture(page, output, `onboarding-${kind}`);
    await writeFile(path.join(workspace, `native-onboarding-${kind}-checked`), 'checked', {
      mode: 0o600,
    });
  }
}

export async function driveInstalledOnboarding(page, workspace, output, capture) {
  await signalFile(path.join(workspace, 'native-onboarding-connected.json'));
  const frame = await approvalFrame(page, '#config-model');
  await frame.locator('#config-model option').first().waitFor({ state: 'attached' });
  assert.notEqual(await frame.locator('.host-status').innerText(), 'Disconnected');
  assert.ok((await frame.locator('#config-model option').count()) > 0);
  const model = frame.locator('#config-model');
  await model.waitFor({ state: 'visible' });
  await model.scrollIntoViewIfNeeded();
  const bounds = await model.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0);
  assert.ok(bounds.x + bounds.width <= viewport.width + 1);
  assert.ok(bounds.y + bounds.height <= viewport.height + 1);
  await capture(page, output, 'installed-connected');
  await writeFile(path.join(workspace, 'native-onboarding-connected-checked'), 'checked', {
    mode: 0o600,
  });
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({
      installed: true,
      publicCommands: true,
      onboarding: true,
      modelControls: true,
      promptGeneration: false,
    }),
    { mode: 0o600 },
  );
}
