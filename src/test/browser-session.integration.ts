import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostTools } from '../host-tools.js';
import { exchangeResult } from '../mutations.js';
import type { BrowserRequest } from '../browser-policy.js';
import { sessionBrowserFixture } from './live-browser-session.js';
import { nativeOwnedTasks } from './tasks.integration.js';
import { nativeWebReads } from './fetch.integration.js';
import { nativeWorkspaceSymbols } from './workspace-symbols.integration.js';
import { nativeReviewedNotebook } from './notebook.integration.js';
import { nativeImageContext } from './image-context.integration.js';

export async function nativeSessionTools(
  root: vscode.Uri,
  api: Parameters<typeof nativeImageContext>[1],
): Promise<void> {
  await nativeOwnedTasks(root);
  await nativeWebReads(root);
  await nativeSessionBrowser(root);
  await nativeWorkspaceSymbols(root);
  await nativeReviewedNotebook(root);
  await nativeImageContext(root, api);
}

export async function nativeSessionBrowser(root: vscode.Uri): Promise<void> {
  const fixture = await sessionBrowserFixture();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'omp-session-browser-'));
  const directory = path.join(privateRoot, 'mutations');
  const config = vscode.workspace.getConfiguration('omp');
  const previous = config.inspect<string>('browser.executablePath')?.globalValue;
  const executablePath = process.env.VS_OMP_BROWSER_EXECUTABLE || '/opt/brave.com/brave/brave';
  await config.update('browser.executablePath', executablePath, vscode.ConfigurationTarget.Global);
  const watchdog = AbortSignal.timeout(30000);
  const tools = new HostTools(
    {
      normalize: async () => {
        throw new Error('No writes');
      },
    },
    {
      read: async () => '',
      write: async () => {
        throw new Error('No writes');
      },
    },
    directory,
    async (approval) => fixture.approve({ ...approval, id: 'native-session-browser' }),
  );
  const control = await chromium.launch({ executablePath });
  const unshared = await control.newPage();
  const scope = (signal = watchdog, owner = 'native-session-browser') => ({
    sessionId: 'native-session-browser',
    owner,
    cwd: root.fsPath,
    signal,
    valid: () => true,
  });
  const invoke = async (request: BrowserRequest) =>
    JSON.parse((await exchangeResult(directory, [{ op: 'browser', request }], watchdog))!);
  try {
    await unshared.goto(fixture.url);
    await unshared.locator('#name').fill('UNSHARED_CONTROL');
    await unshared.locator('#save').click();
    let pageId = '';
    const completed = new AbortController();
    await tools.run(scope(AbortSignal.any([watchdog, completed.signal])), async () => {
      assert.deepEqual((await invoke({ action: 'pages' })).pages, []);
      pageId = (await invoke({ action: 'open', url: fixture.url })).pageId;
      assert.match((await invoke({ action: 'read', pageId })).text, /Waiting/);
      await invoke({ action: 'fill', pageId, selector: '#name', text: fixture.canary });
      await invoke({ action: 'click', pageId, selector: '#save' });
    });
    completed.abort();
    await tools.run(scope(), async () => {
      assert.equal((await invoke({ action: 'pages' })).pages[0].pageId, pageId);
      assert.ok(
        (await invoke({ action: 'read', pageId })).text.includes(`Saved: ${fixture.canary}`),
      );
    });
    await tools.closeBrowser();
    await tools.run(scope(), async () => {
      assert.deepEqual((await invoke({ action: 'pages' })).pages, []);
      await assert.rejects(invoke({ action: 'read', pageId }), /session owner/);
    });
    await tools.run(scope(), async () => {
      await invoke({ action: 'open', url: fixture.url });
    });
    await tools.run(scope(watchdog, 'changed-owner'), async () => {
      assert.deepEqual((await invoke({ action: 'pages' })).pages, []);
    });
    await stoppedSessionBrowser(tools, scope, invoke, fixture.url, watchdog);
    assert.match(await unshared.locator('#result').innerText(), /UNSHARED_CONTROL/);
    assert.equal(unshared.isClosed(), false);
    console.log(
      'PASS: native cross-prompt browser retains form state, revokes exact owner/stale IDs, stops in-flight work and leaves separate unshared control page untouched.',
    );
  } finally {
    await tools.finish();
    await control.close();
    await config.update('browser.executablePath', previous, vscode.ConfigurationTarget.Global);
    await fixture.dispose();
    await rm(privateRoot, { recursive: true, force: true });
  }
}

async function stoppedSessionBrowser(
  tools: HostTools,
  scope: (signal?: AbortSignal, owner?: string) => Parameters<HostTools['run']>[0],
  invoke: (input: BrowserRequest) => Promise<{ pageId: string; pages: unknown[] }>,
  url: string,
  watchdog: AbortSignal,
): Promise<void> {
  const abort = new AbortController();
  await assert.rejects(
    tools.run(scope(AbortSignal.any([watchdog, abort.signal])), async () => {
      const { pageId } = await invoke({ action: 'open', url });
      const timer = setTimeout(() => abort.abort(new Error('Stopped native session browser')), 100);
      try {
        await invoke({ action: 'click', pageId, selector: '#disabled' });
      } finally {
        clearTimeout(timer);
      }
    }),
    /Stopped|abort|closed/i,
  );
  await tools.run(scope(), async () => {
    assert.deepEqual((await invoke({ action: 'pages' })).pages, []);
  });
}
