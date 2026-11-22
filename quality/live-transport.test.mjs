import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { boundedFetch, installLiveTransport } from '../scripts/live-transport.mjs';
import installLiveGuard, { liveArguments, liveSettings } from '../scripts/live-guard.mjs';

const enabled = { VS_OMP_LIVE_TESTS: '1', VS_OMP_LIVE_MODEL: 'github-copilot/gpt-6-luna' };

function transportReport(limits = {}) {
  return {
    startedAt: Date.now(),
    requests: [],
    refused: [],
    limits: {
      transport: 'http',
      model: enabled.VS_OMP_LIVE_MODEL,
      tokens: 100,
      requests: 2,
      seconds: 90,
      runSeconds: 900,
      ...limits,
    },
  };
}

function nativeAttempt(directory, config, file, guarded) {
  const args = [
    '--print',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-context-files',
    '--no-title',
    '--no-lsp',
    '--offline',
    '--max-time',
    '20',
    '--model',
    'vs-omp-transport/transport-probe',
    '--config',
    config,
    '--extension',
    path.resolve('scripts/native-transport-probe.mjs'),
    '/vs-omp-transport-probe',
  ];
  return spawnSync(
    guarded ? process.execPath : process.env.OMP_EXECUTABLE || 'omp',
    guarded ? [path.resolve('scripts/live-omp.mjs'), ...args] : args,
    {
      cwd: directory,
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 1_048_576,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PI_CODING_AGENT_DIR: directory,
        XDG_CONFIG_HOME: directory,
        ELECTRON_RUN_AS_NODE: '1',
        OMP_EXECUTABLE: process.env.OMP_EXECUTABLE || 'omp',
        ...enabled,
        VS_OMP_LIVE_TRANSPORT: '1',
        VS_OMP_LIVE_SECONDS: '20',
        VS_OMP_LIVE_RUN_SECONDS: '20',
        VS_OMP_LIVE_REPORT: path.join(directory, 'observer.json'),
        PI_REQUEST_COMPRESSION: '1',
        VS_OMP_NATIVE_TRANSPORT_PROBE: '1',
        VS_OMP_NATIVE_TRANSPORT_REPORT: file,
      },
    },
  );
}

test('HTTP-only validation copies the owned config without changing provider defaults', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-http-config-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const original = JSON.stringify({
    providers: { openaiResponsesWebsockets: true, openaiWebsockets: 'on', cacheRetention: 'short' },
  });
  await writeFile(file, original, { mode: 0o600, flag: 'wx' });
  const limits = { scenario: 'questions', transport: 'http' };
  const args = await liveArguments(['acp', '--config', file], limits, directory);
  assert.notEqual(args[2], file);
  const copy = JSON.parse(await readFile(args[2], 'utf8'));
  assert.deepEqual(copy.providers, {
    openaiResponsesWebsockets: false,
    openaiWebsockets: 'off',
    cacheRetention: 'short',
  });
  assert.equal(copy.compaction, undefined);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await stat(args[2])).mode & 0o777, 0o600);
  const preflight = ['config', 'get', 'memory.backend', '--json'];
  assert.equal(await liveArguments(preflight, limits, directory), preflight);
});

test(
  'installed Copilot HTTP APIs and native soft summaries use guarded loopback fetch',
  {
    skip: process.env.VS_OMP_NATIVE_TRANSPORT_TESTS !== '1',
  },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-native-transport-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const config = path.join(directory, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        compaction: { methodOrder: ['soft'] },
        providers: { openaiResponsesWebsockets: false, openaiWebsockets: 'off' },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    for (const guarded of [true, false]) {
      const file = path.join(directory, guarded ? 'plain.json' : 'encoded.json');
      const probe = nativeAttempt(directory, config, file, guarded);
      assert.equal(probe.status, 0, 'Native transport process failed; provider output is private.');
      const report = JSON.parse(await readFile(file, 'utf8'));
      if (!guarded) {
        assert.equal(report.status, 'failed');
        assert.equal(report.encodedSeen, true);
        assert.equal(report.receipts.length, report.received.length);
        assert.ok(report.receipts.length < 4);
        continue;
      }
      assert.equal(report.compressionDisabled, true);
      assert.equal(report.encodedSeen, false);
      assert.equal(
        report.status,
        'passed',
        `Native probe stage ${report.stage || 'startup'}: ${report.errorName || 'unknown'}.`,
      );
      assert.equal(report.scope, 'native-http-and-soft-compaction');
      assert.ok(report.receipts.length >= 8);
      assert.equal(report.compactions, 2);
      assert.ok(report.receipts.every((receipt) => receipt.maxOutputTokens === 100));
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_NATIVE_TRANSPORT|fixture-only/);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  },
);

test('opt-in transport counts dispatch not hooks and restores exact fetch ownership', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-transport-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  const handlers = new Map();
  const original = globalThis.fetch;
  let dispatches = 0;
  const fixture = async (_input, init) => {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.requests.length, ++dispatches);
    assert.equal(JSON.parse(init.body).max_output_tokens, 100);
    return new Response('{}');
  };
  globalThis.fetch = fixture;
  context.after(() => {
    globalThis.fetch = original;
  });
  await installLiveGuard(
    { on: (name, handler) => handlers.set(name, handler) },
    {
      ...enabled,
      VS_OMP_LIVE_REPORT: file,
      VS_OMP_LIVE_TRANSPORT: '1',
      VS_OMP_LIVE_REQUESTS: '2',
      VS_OMP_LIVE_TOKENS: '100',
    },
  );
  const native = {
    model: { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses' },
    abort: () => {},
  };
  const body = await handlers.get('before_provider_request')(
    { payload: { model: 'gpt-6-luna', input: ['PRIVATE_TRANSPORT_RECEIPT'] } },
    native,
  );
  assert.equal(JSON.parse(await readFile(file, 'utf8')).requests.length, 0);
  const send = () =>
    fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  await send();
  await send();
  await assert.rejects(send(), /budget/);
  const text = await readFile(file, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_TRANSPORT_RECEIPT/);
  assert.equal(JSON.parse(text).requests.length, 2);
  assert.ok(JSON.parse(text).requests.every((request) => request.source === 'http-transport'));
  assert.deepEqual(await handlers.get('session_before_compact')({}), { cancel: true });
  handlers.get('session_shutdown')();
  assert.equal(globalThis.fetch, fixture);
  assert.equal(dispatches, 2);
  await installLiveGuard(
    { on: (name, handler) => handlers.set(name, handler) },
    {
      ...enabled,
      VS_OMP_LIVE_REPORT: file,
      VS_OMP_LIVE_TRANSPORT: '1',
      VS_OMP_LIVE_REQUESTS: '2',
      VS_OMP_LIVE_TOKENS: '100',
    },
  );
  await assert.rejects(send(), /budget/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).processStarts, 2);
  assert.equal(dispatches, 2);
  handlers.get('session_shutdown')();
  assert.equal(globalThis.fetch, fixture);
  assert.throws(() => liveSettings({ ...enabled, VS_OMP_LIVE_TRANSPORT: 'automatic' }));
});

test('transport caps and authorizes each HTTP attempt without retaining payloads', async (context) => {
  const received = [];
  const authorized = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(payload);
      assert.equal(authorized.length, received.length);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = boundedFetch(fetch, {
    origins: [origin],
    model: 'gpt-6-luna',
    tokens: 100,
    authorize: async (metadata) => {
      assert.ok(authorized.length < 2, 'Request budget refused.');
      authorized.push(metadata);
    },
  });
  const body = { model: 'gpt-6-luna', messages: [{ content: 'PRIVATE_TRANSPORT_PROBE' }] };
  await transport(`${origin}/chat/completions`, { method: 'POST', body: JSON.stringify(body) });
  await transport(
    new Request(`${origin}/responses`, {
      method: 'POST',
      body: JSON.stringify({ ...body, max_output_tokens: 50 }),
    }),
  );
  assert.equal(received[0].max_completion_tokens, 100);
  assert.equal(received[1].max_output_tokens, 50);
  assert.doesNotMatch(JSON.stringify(authorized), /PRIVATE_TRANSPORT_PROBE/);
  const post = (payload = body, endpoint = '/responses', headers) =>
    transport(`${origin}${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    });
  await assert.rejects(post(), /budget/);
  await assert.rejects(post({ ...body, model: 'other' }), /identity/);
  await assert.rejects(post(body, '/unknown'), /endpoint/);
  await assert.rejects(transport(`${origin}/responses`), /method/);
  await assert.rejects(post(body, '/responses', { 'Content-Encoding': 'gzip' }), /Encoded/);
  await assert.rejects(post({ ...body, max_output_tokens: -1 }), /cap/);
  await assert.rejects(post({ ...body, messages: ['x'.repeat(1_048_576)] }), /1 MiB/);
  await assert.rejects(transport(`${origin}/responses`, { method: 'POST', body: '{' }));
  assert.equal(received.length, 2);
  assert.equal(authorized.length, 2);
  assert.equal(body.max_completion_tokens, undefined);
});

test('concurrent reservations precede dispatch and captured wrappers lose ownership', async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const reserved = Promise.withResolvers();
  const release = Promise.withResolvers();
  let dispatches = 0;
  let saves = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.has('content-length'), false);
    dispatches++;
    return new Response('{}');
  };
  const report = transportReport();
  const transport = installLiveTransport(report, async () => {
    if (++saves === 3) reserved.resolve();
    await release.promise;
  });
  const captured = globalThis.fetch;
  const init = { method: 'POST', body: JSON.stringify({ model: 'gpt-6-luna' }) };
  const attempts = Array.from({ length: 3 }, () =>
    captured('https://api.githubcopilot.com/responses', init),
  );
  const settled = Promise.allSettled(attempts);
  await reserved.promise;
  assert.equal(report.requests.length, 2);
  assert.equal(dispatches, 0);
  release.resolve();
  const outcomes = await settled;
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 2);
  assert.equal(dispatches, 2);
  const replacement = async () => new Response('{}');
  globalThis.fetch = replacement;
  await assert.rejects(captured('https://api.githubcopilot.com/responses', init), /budget/);
  transport.restore();
  assert.equal(globalThis.fetch, replacement);
  assert.equal(dispatches, 2);
});

test('startup and reservation persistence failures never leave dispatch authority', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-transport-write-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  let dispatches = 0;
  const fixture = async () => {
    dispatches++;
    return new Response('{}');
  };
  globalThis.fetch = fixture;
  await assert.rejects(
    installLiveGuard(
      { on: () => {} },
      {
        ...enabled,
        VS_OMP_LIVE_REPORT: path.join(directory, 'missing', 'report.json'),
        VS_OMP_LIVE_TRANSPORT: '1',
      },
    ),
    { code: 'ENOENT' },
  );
  assert.equal(globalThis.fetch, fixture);
  const report = transportReport({ requests: 1 });
  const transport = installLiveTransport(report, async () => {
    throw new Error('Storage unavailable.');
  });
  const send = () =>
    fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna' }),
    });
  await assert.rejects(send(), /Storage unavailable/);
  assert.equal(report.requests.length, 1);
  await assert.rejects(send(), /Storage unavailable/);
  assert.equal(report.requests.length, 1);
  assert.equal(dispatches, 0);
  transport.restore();
});

test('abort cancels a pending body reader and prevents dispatch after authorization', async () => {
  let dispatches = 0;
  let authorized = 0;
  let cancelled = 0;
  const ready = Promise.withResolvers();
  const controller = new AbortController();
  const body = new ReadableStream({
    pull: () => {
      ready.resolve();
    },
    cancel: () => {
      cancelled++;
    },
  });
  const transport = boundedFetch(
    async () => {
      dispatches++;
      return new Response('{}');
    },
    {
      origins: ['https://api.githubcopilot.com'],
      model: 'gpt-6-luna',
      tokens: 100,
      authorize: async () => {
        authorized++;
      },
    },
  );
  const pending = transport(
    new Request('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    }),
  );
  await ready.promise;
  controller.abort(new Error('Owned body cancellation.'));
  await assert.rejects(pending, /Owned body cancellation/);
  assert.equal(cancelled, 1);
  assert.equal(authorized, 0);
  const reserved = Promise.withResolvers();
  const release = Promise.withResolvers();
  const duringSave = new AbortController();
  const delayed = boundedFetch(
    async () => {
      dispatches++;
      return new Response('{}');
    },
    {
      origins: ['https://api.githubcopilot.com'],
      model: 'gpt-6-luna',
      tokens: 100,
      authorize: async () => {
        reserved.resolve();
        await release.promise;
      },
    },
  );
  const saving = delayed('https://api.githubcopilot.com/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-6-luna' }),
    signal: duringSave.signal,
  });
  await reserved.promise;
  duringSave.abort(new Error('Owned reservation cancellation.'));
  release.resolve();
  await assert.rejects(saving, /Owned reservation cancellation/);
  assert.equal(dispatches, 0);
});

test('aggregate expiry during reservation persistence refuses the reserved dispatch', async (context) => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  context.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });
  let now = originalNow();
  Date.now = () => now;
  let dispatches = 0;
  globalThis.fetch = async () => {
    dispatches++;
    return new Response('{}');
  };
  const report = transportReport({ requests: 1, seconds: 1, runSeconds: 1 });
  const transport = installLiveTransport(report, async () => {
    now += 1001;
  });
  await assert.rejects(
    fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna' }),
    }),
    /budget/,
  );
  assert.equal(report.requests.length, 1);
  assert.equal(report.refused.length, 1);
  assert.equal(dispatches, 0);
  transport.restore();
});

test('compaction requires owned HTTP transport, tested API, and exact budgeted model', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-compact-guard-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const handlers = new Map();
  const file = path.join(directory, 'report.json');
  await installLiveGuard(
    { on: (name, handler) => handlers.set(name, handler) },
    {
      ...enabled,
      VS_OMP_LIVE_REPORT: file,
      VS_OMP_LIVE_TRANSPORT: '1',
    },
  );
  context.after(() => handlers.get('session_shutdown')());
  const allowed = {
    model: { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses' },
  };
  const compact = (native) => handlers.get('session_before_compact')({}, native);
  assert.equal(await compact(allowed), undefined);
  assert.deepEqual(await compact({ model: { ...allowed.model, id: 'other' } }), { cancel: true });
  assert.deepEqual(await compact({ model: { ...allowed.model, api: 'anthropic-messages' } }), {
    cancel: true,
  });
  globalThis.fetch = async () => {
    throw new Error('No network permitted.');
  };
  assert.deepEqual(await compact(allowed), { cancel: true });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).requests.length, 0);
});
