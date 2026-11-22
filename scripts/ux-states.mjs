import assert from 'node:assert/strict';

export async function checkPresentationStates(page, directory, name, screenshot) {
  for (const phase of ['empty', 'waiting', 'error']) {
    await page.evaluate((phase) => {
      Object.assign(globalThis.fixtureState, {
        busy: phase === 'waiting',
        cancellable: true,
        question: undefined,
        approval: undefined,
        changes: [],
        error:
          phase === 'error' ? `Fixture error: ${'bounded diagnostic text '.repeat(12)}` : undefined,
        turns:
          phase === 'waiting'
            ? [
                {
                  id: 'waiting',
                  prompt: 'Inspect output',
                  status: 'running',
                  startedAt: Date.now(),
                  blocks: [
                    { id: 'read', kind: 'tool', title: 'Read', status: 'running', text: '' },
                  ],
                },
              ]
            : [],
      });
      globalThis.window.postMessage(
        { v: 1, type: 'state', state: globalThis.fixtureState },
        globalThis.window.location.origin,
      );
    }, phase);
    await page.locator('.transcript').waitFor();
    if (phase === 'empty')
      await page.waitForFunction(
        () => globalThis.document.querySelector('.transcript')?.childElementCount === 0,
      );
    if (phase === 'waiting')
      await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    if (phase === 'error')
      await page.locator('.attention').filter({ hasText: 'Fixture error:' }).waitFor();
    const layout = await page.evaluate(() => {
      const { document, innerWidth, innerHeight } = globalThis;
      const control =
        document.querySelector('[data-action="cancel"]') ?? document.querySelector('#prompt');
      const bounds = control.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        controlVisible:
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight &&
          bounds.left >= 0 &&
          bounds.right <= innerWidth,
      };
    });
    assert.deepEqual(layout, { overflow: false, controlVisible: true });
    await screenshot(page, directory, `${name}-${phase}`);
  }
  const submissions = await page.evaluate(() =>
    globalThis.messages.filter((message) => ['prompt', 'queuePrompt'].includes(message.type)),
  );
  assert.deepEqual(submissions, []);
}

export async function checkSessionStates(page, directory, name, screenshot) {
  await page.evaluate(() => {
    globalThis.window.postMessage(
      { v: 1, type: 'showSessions' },
      globalThis.window.location.origin,
    );
  });
  await page.getByRole('tab', { name: 'Recent', exact: true }).click();
  for (const phase of ['loading', 'empty', 'error', 'no-match']) {
    await page.evaluate((phase) => {
      Object.assign(globalThis.fixtureState, {
        busy: false,
        sessions: phase === 'loading' ? undefined : [],
        error: phase === 'error' ? 'Fixture session load failed.' : undefined,
      });
      globalThis.window.postMessage(
        { v: 1, type: 'state', state: globalThis.fixtureState },
        globalThis.window.location.origin,
      );
    }, phase);
    if (phase === 'no-match')
      await page.getByRole('searchbox', { name: 'Search Sessions', exact: true }).fill('NO_MATCH');
    const status =
      phase === 'loading'
        ? 'Loading sessions...'
        : phase === 'no-match'
          ? 'No matching sessions.'
          : 'No recent sessions.';
    await page.locator('.session-empty').filter({ hasText: status }).waitFor();
    if (phase === 'error')
      await page
        .locator('.attention')
        .filter({ hasText: 'Fixture session load failed.' })
        .waitFor();
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      ),
      false,
    );
    await screenshot(page, directory, `${name}-sessions-${phase}`);
  }
}
