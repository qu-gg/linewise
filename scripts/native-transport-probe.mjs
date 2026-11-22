import assert from 'node:assert/strict';
import { completeSimple } from '@oh-my-pi/pi-ai';
import { resolveModelPolicy } from '@oh-my-pi/pi-catalog/compat/resolve';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { boundedFetch } from './live-transport.mjs';

function fixtureResponse(api) {
  const message = { role: 'assistant', content: 'LOCAL_TRANSPORT_ONLY' };
  if (api === 'openai-completions')
    return [
      {
        choices: [{ index: 0, delta: message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
  const item = {
    type: 'message',
    id: 'local-message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: message.content, annotations: [] }],
  };
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: message.content,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'local-response',
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function probeServer(receipts, received) {
  return createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ cap: payload.max_completion_tokens ?? payload.max_output_tokens });
      assert.equal(receipts.length, received.length);
      const api = request.url.endsWith('/responses') ? 'openai-responses' : 'openai-completions';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        `${fixtureResponse(api)
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join('')}data: [DONE]\n\n`,
      );
    });
  });
}

async function completeProbe(sourceModel, api, provider, origin) {
  const model = {
    ...sourceModel,
    api,
    provider,
    id: 'transport-probe',
    name: 'Disposable local transport',
    baseUrl: origin,
    reasoning: false,
    preferWebsockets: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const resolved = { ...model, ...resolveModelPolicy(model) };
  const result = await completeSimple(
    resolved,
    {
      messages: [
        { role: 'user', content: 'PRIVATE_NATIVE_TRANSPORT'.repeat(80), timestamp: Date.now() },
      ],
    },
    { apiKey: 'fixture-only', maxTokens: 512, signal: AbortSignal.timeout(5000) },
  );
  assert.equal(result.stopReason, 'stop');
  assert.ok(
    result.content.some((block) => block.type === 'text' && block.text === 'LOCAL_TRANSPORT_ONLY'),
  );
}

async function nativeCompaction(api, context, model, state) {
  const resolved = { ...model, ...resolveModelPolicy(model) };
  assert.equal(await api.setModel(resolved), true);
  state.stage = 'native-soft-compaction';
  const content = Array.from(
    { length: 1200 },
    (_, index) => `Archive ${index}: retain workspace ownership and immutable context snapshots.\n`,
  ).join('');
  for (const part of ['first', 'second'])
    api.sendMessage(
      {
        customType: 'vs-omp-transport-history',
        content: `${part}\n${content}`,
        display: false,
      },
      { triggerTurn: false },
    );
  const before = state.receipts.length;
  await context.compact('Produce a short plain-text summary of the archived fixture.');
  assert.ok(state.receipts.length >= before + 2, 'Native full and short summaries must dispatch.');
  assert.equal(state.received.length, state.receipts.length);
  const committed = context.sessionManager
    .getBranch()
    .filter((entry) => entry.type === 'compaction');
  assert.equal(committed.length, (state.compactions || 0) + 1);
  assert.ok(committed.every((entry) => entry.summary.includes('LOCAL_TRANSPORT_ONLY')));
  state.compactions = committed.length;
}

async function runProbe(state, sourceModel, api, context) {
  const receipts = [];
  const received = [];
  state.receipts = receipts;
  state.received = received;
  const server = probeServer(receipts, received);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const providerOrigin = 'https://api.githubcopilot.com';
  const original = globalThis.fetch;
  const transport = boundedFetch(
    (url, init) => original(`${origin}${new URL(url).pathname}`, init),
    {
      origins: [providerOrigin],
      model: 'transport-probe',
      tokens: 100,
      signal: () => AbortSignal.timeout(5000),
      authorize: async (metadata) => {
        receipts.push(metadata);
      },
    },
  );
  state.encodedSeen = false;
  state.compressionDisabled = process.env.PI_REQUEST_COMPRESSION === '0';
  globalThis.fetch = (input, init) => {
    if (new Headers(init?.headers).has('content-encoding')) state.encodedSeen = true;
    return transport(input, init);
  };
  try {
    for (const api of ['openai-completions', 'openai-responses']) {
      state.stage = api;
      for (const provider of ['vs-omp-transport', 'github-copilot'])
        await completeProbe(sourceModel, api, provider, providerOrigin);
    }
    assert.equal(received.length, 4);
    assert.ok(received.every((entry) => entry.cap === 100));
    for (const protocol of ['openai-completions', 'openai-responses']) {
      await nativeCompaction(
        api,
        context,
        {
          ...sourceModel,
          provider: 'github-copilot',
          api: protocol,
          baseUrl: providerOrigin,
          preferWebsockets: false,
        },
        state,
      );
    }
    return {
      status: 'passed',
      scope: 'native-http-and-soft-compaction',
      receipts,
      received,
      compactions: state.compactions,
      compressionDisabled: state.compressionDisabled,
      encodedSeen: state.encodedSeen,
    };
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export default function installProbe(api) {
  assert.equal(process.env.VS_OMP_NATIVE_TRANSPORT_PROBE, '1');
  assert.ok(process.env.VS_OMP_NATIVE_TRANSPORT_REPORT);
  const provider = {
    api: 'openai-completions',
    apiKey: 'fixture-only',
    baseUrl: 'http://127.0.0.1:1',
    models: [
      {
        id: 'transport-probe',
        name: 'Local transport probe',
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  for (const name of ['vs-omp-transport', 'github-copilot']) api.registerProvider(name, provider);
  api.on('before_agent_start', () => {
    throw new Error('Probe refuses every agent generation.');
  });
  api.registerCommand('vs-omp-transport-probe', {
    description: 'Run loopback transport validation',
    handler: async (_args, context) => {
      let report;
      const state = {};
      try {
        report = await runProbe(state, context.model, api, context);
      } catch (error) {
        report = {
          status: 'failed',
          scope: 'native-http-and-soft-compaction',
          ...state,
          errorName: error?.name === 'AssertionError' ? 'assertion' : 'runtime',
        };
      }
      await writeFile(process.env.VS_OMP_NATIVE_TRANSPORT_REPORT, JSON.stringify(report), {
        mode: 0o600,
        flag: 'wx',
      });
    },
  });
}
