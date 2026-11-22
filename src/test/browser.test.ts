import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { browserRequest, browserReason } from '../browser-policy.js';
import { OwnedBrowser, SessionBrowser } from '../browser.js';
import { chromium } from 'playwright-core';
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { engine, nativeBrowserTool } from './browser-fixture.js';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { HostTools } = await import('../host-tools.js');

test('owned browser accepts bounded HTTP actions but no existing sessions or script execution', () => {
  const pageId = randomUUID();
  for (const input of [
    { action: 'open', url: 'http://127.0.0.1:8080/' },
    { action: 'read', pageId },
    { action: 'click', pageId, selector: 'button[type=submit]' },
    { action: 'viewport', pageId, width: 420, height: 900 },
  ])
    assert.equal(browserRequest.safeParse(input).success, true);
  for (const input of [
    { action: 'open', url: 'file:///etc/passwd' },
    { action: 'open', url: 'https://user:password@example.com/' },
    { action: 'open', url: 'https://example.com/', profile: '/home/user' },
    { action: 'connect', endpoint: 'http://localhost:9222' },
    { action: 'evaluate', pageId, script: 'document.cookie' },
    { action: 'read', pageId: 'existing-tab' },
    { action: 'viewport', pageId, width: 9000, height: 900 },
  ])
    assert.ok(browserReason(input));
  assert.equal(browserReason({ action: 'pages' }), undefined);
});

test('owned browser refuses invalid/stale pages and consent without launching a process', async () => {
  const abort = new AbortController();
  let approvals = 0;
  const browser = new OwnedBrowser({
    signal: abort.signal,
    approve: async () => {
      approvals++;
      return false;
    },
  });
  assert.deepEqual(JSON.parse(await browser.execute({ action: 'pages' })), {
    pages: [],
    ownedOnly: true,
  });
  await assert.rejects(
    browser.execute({ action: 'read', pageId: randomUUID() }),
    /belongs to this session owner/,
  );
  await assert.rejects(
    browser.execute({ action: 'open', url: 'https://example.com' }),
    /not approved/,
  );
  assert.equal(approvals, 1);
  abort.abort(new Error('Stopped owned browser'));
  await assert.rejects(browser.execute({ action: 'pages' }), /Stopped owned browser/);
  await browser.dispose();
  await browser.dispose();
});

test('owned browser separates lifetime from per-prompt consent and cancellation', async (context) => {
  const { state } = engine(context);
  const lifetime = new AbortController();
  const first = new AbortController();
  const second = new AbortController();
  const approvals: string[] = [];
  const browser = new OwnedBrowser({
    signal: lifetime.signal,
    approve: async () => {
      throw new Error('Retired consent must never run');
    },
  });
  context.after(() => browser.dispose());
  const opened = JSON.parse(
    await browser.execute(
      { action: 'open', url: 'https://example.com' },
      {
        signal: first.signal,
        approve: async () => {
          approvals.push('first');
          return true;
        },
      },
    ),
  );
  first.abort(new Error('First prompt completed'));
  assert.equal(state.closed, false);
  await assert.rejects(
    browser.execute(
      { action: 'read', pageId: opened.pageId },
      { signal: first.signal, approve: async () => true },
    ),
    /First prompt completed/,
  );
  assert.equal(
    JSON.parse(
      await browser.execute(
        { action: 'pages' },
        { signal: second.signal, approve: async () => false },
      ),
    ).pages.length,
    1,
  );
  await assert.rejects(
    browser.execute(
      { action: 'navigate', pageId: opened.pageId, url: 'https://example.com/new' },
      {
        signal: second.signal,
        approve: async () => {
          approvals.push('second');
          return false;
        },
      },
    ),
    /not approved/,
  );
  assert.deepEqual(approvals, ['first', 'second']);
  await assert.rejects(
    browser.execute(
      { action: 'navigate', pageId: opened.pageId, url: 'https://example.com/new' },
      {
        signal: second.signal,
        approve: async () => {
          second.abort(new Error('Stop second prompt'));
          return true;
        },
      },
    ),
    /Stop second prompt/,
  );
  await browser.dispose();
  assert.equal(state.closed, true);
});

test('session browser revokes authority on owner change and explicit close while preserving completed prompts', async (context) => {
  const { state } = engine(context);
  const browser = new SessionBrowser();
  context.after(() => browser.revoke());
  const first = new AbortController();
  const options = { signal: first.signal, approve: async () => true };
  const opened = JSON.parse(
    await browser.execute(
      'session/root/branch',
      { action: 'open', url: 'https://example.com' },
      options,
    ),
  );
  first.abort();
  const next = { signal: new AbortController().signal, approve: async () => false };
  assert.equal(
    JSON.parse(await browser.execute('session/root/branch', { action: 'pages' }, next)).pages[0]
      .pageId,
    opened.pageId,
  );
  assert.deepEqual(
    JSON.parse(await browser.execute('different-session/root/branch', { action: 'pages' }, next))
      .pages,
    [],
  );
  assert.equal(state.closed, true);
  const second = JSON.parse(
    await browser.execute(
      'different-session/root/branch',
      { action: 'open', url: 'https://example.com' },
      { ...next, approve: async () => true },
    ),
  );
  assert.notEqual(second.pageId, opened.pageId);
  await browser.revoke();
  await browser.revoke();
  assert.deepEqual(
    JSON.parse(await browser.execute('different-session/root/branch', { action: 'pages' }, next))
      .pages,
    [],
  );
});

test('session browser revocation cancels pending approval and rejects late consent', async (context) => {
  const { state } = engine(context);
  const browser = new SessionBrowser();
  context.after(() => browser.revoke());
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const action = browser.execute(
    'owner',
    { action: 'open', url: 'https://example.com' },
    {
      signal: new AbortController().signal,
      approve: async (_request, signal) => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return true;
      },
    },
  );
  await pending;
  await assert.rejects(
    browser.execute(
      'owner',
      { action: 'pages' },
      { signal: new AbortController().signal, approve: async () => true },
    ),
    /still pending/,
  );
  await browser.revoke();
  await assert.rejects(action, /abort/i);
  release();
  assert.equal(state.pages.length, 0);
});

test('owned browser exercises bounded reads, all permitted interactions, console and four-page ownership', async (context) => {
  const { dom, state } = engine(context);
  const browser = new OwnedBrowser({
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(() => browser.dispose());
  const invoke = async (input: unknown) => JSON.parse(await browser.execute(input));
  const { pageId } = await invoke({ action: 'open', url: 'https://example.com' });
  const call = (action: string, fields: Record<string, unknown> = {}) =>
    invoke({ action, pageId, ...fields });
  const initial = await call('read');
  assert.ok(initial.text.includes('Untrusted fixture'));
  assert.ok(!JSON.stringify(initial).includes('NEVER_'));
  assert.ok(
    initial.controls.some((control: { selector: string }) => control.selector.includes('nth=')),
  );
  for (const action of ['click', 'hover', 'fill', 'press', 'select'])
    await call(action, {
      selector: '#exact',
      ...(action === 'fill' ? { text: 'exact' } : {}),
      ...(action === 'press' ? { key: 'Enter' } : {}),
      ...(action === 'select' ? { values: ['one'] } : {}),
    });
  await assert.rejects(call('click', { selector: '.ambiguous' }), /exactly one/);
  await assert.rejects(call('fill', { selector: '#password', text: 'refused' }), /Password/);
  for (const action of ['back', 'forward', 'reload']) await call(action);
  await call('viewport', { width: 420, height: 800 });
  await call('navigate', { url: 'https://example.com/next' });
  assert.equal((await call('screenshot')).data, state.image.toString('base64'));
  state.image = Buffer.alloc(512 * 1024 + 1);
  await assert.rejects(call('screenshot'), /512 KiB/);
  const page = state.pages[0];
  assert.ok(page);
  for (let count = 0; count < 70; count++)
    page.emit('console', { type: () => 'log', text: () => 'bounded'.repeat(100) });
  page.emit('pageerror', new Error('Fixture error'));
  page.emit('requestfailed', { url: () => 'https://example.com/missing' });
  assert.equal((await call('console')).messages.length, 64);
  page.emit('popup', { close: async () => {} });
  page.emit('download', { cancel: async () => {} });
  let allowed = 0;
  let denied = 0;
  const route = state.routes[0];
  assert.ok(route);
  for (const url of ['https://example.com', 'file:///etc/passwd'])
    await route({
      request: () => ({ url: () => url }),
      continue: async () => {
        allowed++;
      },
      abort: async () => {
        denied++;
      },
    });
  assert.deepEqual([allowed, denied], [1, 1]);
  dom.window.document.body.append('large'.repeat(9000));
  assert.equal((await call('read')).limited, true);
  for (let count = 0; count < 3; count++)
    await invoke({ action: 'open', url: 'https://example.com' });
  await assert.rejects(invoke({ action: 'open', url: 'https://example.com' }), /four owned pages/);
  assert.equal((await invoke({ action: 'pages' })).pages.length, 4);
  await call('close');
  await assert.rejects(call('read'), /belongs to this session owner/);
  await assert.rejects(
    invoke({ action: 'open', url: 'https://example.com/fail' }),
    /Navigation failure/,
  );
  await browser.dispose();
  assert.equal(state.closed, true);
  await assert.rejects(invoke({ action: 'pages' }), /has closed/);
});

test('owned browser serializes pending consent, refuses stale approval, and tolerates unavailable launch cleanup', async (context) => {
  engine(context);
  const abort = new AbortController();
  let consent!: (allowed: boolean) => void;
  const browser = new OwnedBrowser({
    signal: abort.signal,
    approve: () =>
      new Promise((resolve) => {
        consent = resolve;
      }),
  });
  const pending = browser.execute({ action: 'open', url: 'https://example.com' });
  await assert.rejects(browser.execute({ action: 'pages' }), /still pending/);
  abort.abort(new Error('Stopped before consent'));
  consent(true);
  await assert.rejects(pending, /Stopped before consent/);
  await browser.dispose();
  context.mock.method(chromium, 'launch', async () => {
    throw new Error('Browser unavailable');
  });
  const unavailable = new OwnedBrowser({
    signal: new AbortController().signal,
    approve: async () => true,
  });
  await assert.rejects(
    unavailable.execute({ action: 'open', url: 'https://example.com' }),
    /unavailable/,
  );
  await unavailable.dispose();
});

test('registered browser uses the actual prompt broker, explicit consent and image transport without review mutations', async (context) => {
  reset();
  const { state } = engine(context);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-browser-broker-'));
  const privateRoot = path.join(cwd, 'private');
  context.after(() => rm(cwd, { recursive: true, force: true }));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const tool = nativeBrowserTool();
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const abort = new AbortController();
  const invoke = async (input: unknown) =>
    tool.execute(randomUUID(), input, abort.signal, undefined, {
      cwd,
      sessionManager: { getSessionId: () => 'browser-test' },
    }) as Promise<{ content: { type: string; text?: string; data?: string }[] }>;
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(invoke({ action: 'pages' }), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = privateRoot;
  await assert.rejects(invoke({ action: 'evaluate', script: 'refused' }));
  const approvals: string[] = [];
  let valid = true;
  let retireOnApproval = false;
  const tools = new HostTools(
    {
      normalize: noWrites,
    },
    {
      read: async () => '',
      write: noWrites,
    },
    path.join(privateRoot, 'mutations'),
    async (prompt) => {
      approvals.push(prompt.title);
      if (retireOnApproval) valid = false;
      return true;
    },
  );
  const scope = () => ({
    sessionId: 'browser-test',
    owner: 'browser-owner',
    cwd,
    signal: abort.signal,
    valid: () => valid,
  });
  let captured = '';
  await tools.run(scope(), async () => {
    fixture.configuration.set('omp.browser.executablePath', 'relative-browser');
    await assert.rejects(invoke({ action: 'pages' }), /absolute user browser/);
    fixture.configuration.delete('omp.browser.executablePath');
    const opened = await invoke({ action: 'open', url: 'https://example.com' });
    captured = JSON.parse(opened.content[0]!.text!).pageId;
    const image = await invoke({ action: 'screenshot', pageId: captured });
    assert.equal(image.content[0]!.type, 'image');
    assert.equal(image.content[0]!.data, state.image.toString('base64'));
  });
  assert.equal(state.closed, false);
  assert.deepEqual(approvals, ['Allow Owned Browser Action?']);
  await tools.run(scope(), async () => {
    const read = await invoke({ action: 'read', pageId: captured });
    assert.match(read.content[0]!.text!, /Untrusted fixture/);
    retireOnApproval = true;
    await assert.rejects(
      invoke({ action: 'open', url: 'https://example.com' }),
      /No active prompt/,
    );
    valid = true;
  });
  abort.abort(new Error('Stopped broker'));
  await assert.rejects(invoke({ action: 'pages' }), /Stopped broker/);
  await tools.finish();
  assert.equal(state.closed, true);
});

async function noWrites(): Promise<never> {
  throw new Error('No writes');
}
