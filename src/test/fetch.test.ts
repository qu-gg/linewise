import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchRequest } from '../fetch-policy.js';
import { fetchWeb } from '../host-fetch.js';
import type { RequestApproval } from '../approvals.js';
import { register } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { installNativeFetch } from '../native-fetch.js';
import type { NativeEditApi } from '../native-edit.js';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { HostTools } = await import('../host-tools.js');

async function setup(
  context: TestContext,
  route: (request: IncomingMessage, response: ServerResponse) => void,
  approve?: RequestApproval,
) {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const abort = new AbortController();
  const state = { active: true };
  const approvals: string[] = [];
  const invoke = async (target = '/') =>
    JSON.parse(
      await fetchWeb(
        fetchRequest.parse({ url: base + target }),
        { signal: abort.signal, valid: () => state.active },
        async (request, signal, valid) => {
          approvals.push(request.summary);
          assert.equal(request.configurable, false);
          return approve ? approve(request, signal, valid) : true;
        },
      ),
    );
  return { base, abort, state, requests, approvals, invoke };
}

test('web reads accept only bounded HTTP URLs without alternate request authority', () => {
  for (const url of ['https://example.com/docs', 'http://127.0.0.1:8080/status'])
    assert.equal(fetchRequest.safeParse({ url }).success, true);
  for (const input of [
    { url: 'file:///etc/passwd' },
    { url: 'https://user:password@example.com/' },
    { url: 'javascript:alert(1)' },
    { url: 'https://example.com/\n' },
    { url: 'https://example.com/' + 'a'.repeat(4096) },
    { url: 'https://example.com/', headers: { authorization: 'injected' } },
    { url: 'https://example.com/', method: 'POST' },
    { url: 'https://example.com/', body: 'injected' },
  ])
    assert.equal(fetchRequest.safeParse(input).success, false);
});

test('approved web reads return untrusted HTML without executing it or sending identity headers', async (context) => {
  const html = '<h1>Exact web fixture</h1><script>fetch("/must-not-load")</script>';
  const current = await setup(context, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'private=session',
    });
    response.end(html);
  });
  const result = await current.invoke('/#ignored-fragment');
  assert.equal(result.text, html);
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.url, current.base + '/');
  assert.equal(current.requests.length, 1);
  for (const header of ['authorization', 'cookie', 'referer'])
    assert.equal(current.requests[0]!.headers[header], undefined);
  assert.equal(current.requests[0]!.method, 'GET');
  await current.invoke('/');
  assert.equal(current.requests.length, 2);
  assert.equal(current.requests[1]!.headers.cookie, undefined);
});

test('every redirect requests consent and a refused destination is never contacted', async (context) => {
  const current = await setup(
    context,
    (_request, response) => {
      response.writeHead(302, { location: '/private' });
      response.end();
    },
    async (approval) => !approval.summary.endsWith('/private'),
  );
  await assert.rejects(current.invoke('/start'), /not approved/);
  assert.deepEqual(
    current.requests.map((request) => request.url),
    ['/start'],
  );
  assert.deepEqual(current.approvals, [`GET ${current.base}/start`, `GET ${current.base}/private`]);
});

test('web redirects are bounded and refuse cycles, credentials and alternate schemes', async (context) => {
  let location = '/same';
  const current = await setup(context, (request, response) => {
    response.writeHead(302, {
      location: request.url!.startsWith('/chain')
        ? `/chain${Number(request.url!.slice(6)) + 1}`
        : location,
    });
    response.end();
  });
  await assert.rejects(current.invoke('/same'), /cycle/);
  for (const target of ['file:///private', 'https://user:pass@example.com/']) {
    location = target;
    await assert.rejects(current.invoke('/unsafe'));
  }
  await assert.rejects(current.invoke('/chain0'), /four hops/);
});

test('text decoding, non-success HTTP status and JSON escaping stay bounded', async (context) => {
  const current = await setup(context, (request, response) => {
    if (request.url === '/encoded') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=windows-1252' });
      response.end(Buffer.from([0xe9]));
    } else if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end('{"error":"missing"}');
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(('"\n' + String.fromCodePoint(0x1f642)).repeat(100000));
    }
  });
  assert.equal((await current.invoke('/encoded')).text, String.fromCharCode(0xe9));
  const missing = await current.invoke('/missing');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.text), { error: 'missing' });
  const bounded = await current.invoke('/large');
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 63000);
  assert.ok(bounded.text.length <= 40000);
});

test('unsupported content types, charsets and binary text are refused', async (context) => {
  let type: string | undefined = 'image/png';
  let content = 'not exposed';
  const current = await setup(context, (_request, response) => {
    if (type) response.setHeader('content-type', type);
    response.end(content);
  });
  for (const candidate of [
    'image/png',
    undefined,
    'malformed',
    'text/plain;charset=unknown-charset',
    'x'.repeat(1025),
  ]) {
    type = candidate;
    await assert.rejects(current.invoke());
  }
  type = 'text/plain';
  content = '\0binary';
  await assert.rejects(current.invoke(), /binary/);
});

test('Stop cancels indefinite web approval and a late allow never starts a request', async (context) => {
  let allow!: (value: boolean) => void;
  let shown!: () => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const current = await setup(
    context,
    (_request, response) => response.end('must not fetch'),
    async () => {
      shown();
      return new Promise<boolean>((resolve) => {
        allow = resolve;
      });
    },
  );
  const running = current.invoke();
  const rejected = assert.rejects(running, /Stopped/);
  await visible;
  current.abort.abort(new Error('Stopped'));
  await rejected;
  allow(true);
  assert.equal(current.requests.length, 0);
});

test('stale web ownership cannot use a pending approval', async (context) => {
  const current = await setup(
    context,
    (_request, response) => response.end('must not fetch'),
    async () => {
      current.state.active = false;
      return true;
    },
  );
  await assert.rejects(current.invoke(), /retired/);
  assert.equal(current.requests.length, 0);
});

test('Stop aborts a stalled web response stream', { timeout: 5000 }, async (context) => {
  let started!: () => void;
  const visible = new Promise<void>((resolve) => {
    started = resolve;
  });
  const current = await setup(context, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('partial', started);
  });
  const running = current.invoke();
  const rejected = assert.rejects(running, /Stop|abort/i);
  await visible;
  current.abort.abort(new Error('Stopped'));
  await rejected;
});

test('approved redirects, empty bodies and Unicode boundaries preserve exact result semantics', async (context) => {
  const current = await setup(context, (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(303, { location: '/document' });
      response.end();
    } else if (request.url === '/empty') {
      response.writeHead(204);
      response.end();
    } else if (request.url === '/missing-target') {
      response.writeHead(302);
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('a'.repeat(39999) + String.fromCodePoint(0x1f642));
    }
  });
  const result = await current.invoke('/redirect');
  assert.equal(result.url, current.base + '/document');
  assert.equal(result.text, 'a'.repeat(39999));
  assert.equal(result.truncated, true);
  assert.equal((await current.invoke('/empty')).text, '');
  await assert.rejects(current.invoke('/missing-target'), /missing a target/);
});

test('registered web reads require per-URL consent through the broker under command Allow All and YOLO', async (context) => {
  reset();
  const current = await setup(context, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('BROKER_WEB_DATA');
  });
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-web-broker-'));
  const artifacts = path.join(cwd, 'private');
  await mkdir(artifacts);
  context.after(() => rm(cwd, { recursive: true, force: true }));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeFetch({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  assert.equal(tool.approval, 'read');
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  const input = { url: current.base + '/' };
  const native = { cwd, sessionManager: { getSessionId: () => 'owner' } };
  const execute = () => tool.execute(randomUUID(), input, current.abort.signal, undefined, native);
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  process.env.VS_OMP_ARTIFACTS_ROOT = artifacts;
  let allowed = true;
  let approvals = 0;
  const tools = new HostTools(
    {
      normalize: async () => {
        throw new Error('No file writes');
      },
    },
    {
      read: async () => '',
      write: async () => {
        throw new Error('No file writes');
      },
    },
    path.join(artifacts, 'mutations'),
    async (approval) => {
      approvals++;
      assert.equal(approval.configurable, false);
      assert.equal(approval.summary, `GET ${input.url}`);
      return allowed;
    },
  );
  for (const mode of ['all', 'yolo'] as const) {
    fixture.quickPick = mode;
    fixture.approval = mode === 'all' ? 'Enable Allow All' : 'Enable YOLO';
    await tools.pickPermissions();
    assert.equal(tools.permissions, mode);
    allowed = true;
    await tools.run(
      { sessionId: 'owner', owner: 'local', cwd, signal: current.abort.signal, valid: () => true },
      async () => {
        const result = (await execute()) as { content: { text: string }[] };
        assert.equal(JSON.parse(result.content[0]!.text).text, 'BROKER_WEB_DATA');
        allowed = false;
        await assert.rejects(execute(), /not approved/);
      },
    );
  }
  assert.equal(approvals, 4);
  assert.equal(current.requests.length, 2);
  await assert.rejects(
    tool.execute(randomUUID(), input, AbortSignal.abort(new Error('Stopped')), undefined, native),
    /Stopped/,
  );
});
