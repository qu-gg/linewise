import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenRouterRoutes,
  openRouterModel,
  optimalRoute,
  parseOpenRouterProviders,
  routeBaseModel,
  routeProvider,
  routeSelector,
} from '../model-routes.js';

const endpoints = {
  data: {
    endpoints: [
      {
        provider_name: 'BaseTen',
        tag: 'baseten/fast',
        status: 0,
      },
      {
        provider_name: 'BaseTen',
        tag: 'baseten',
        status: 0,
      },
      {
        provider_name: 'Nebius',
        tag: 'nebius/fp4',
        status: 0,
      },
      {
        provider_name: 'Unavailable',
        tag: 'unavailable/fp8',
        status: -5,
      },
      {
        provider_name: '<script>',
        tag: 'not a slug',
      },
    ],
  },
};

const rankedEndpoints = {
  data: {
    endpoints: [
      {
        provider_name: 'BaseTen',
        tag: 'baseten/slow',
        status: 0,
        throughput_last_30m: { p50: 20 },
        pricing: { completion: '0.000001' },
      },
      {
        provider_name: 'BaseTen',
        tag: 'baseten/fast',
        status: 0,
        throughput_last_30m: { p50: 60 },
        pricing: { completion: '0.000002' },
      },
      {
        provider_name: 'Scalar',
        tag: 'scalar/fp8',
        status: 0,
        throughput_last_30m: 30,
        pricing: { completion: '0.000001' },
      },
      {
        provider_name: 'Zeta',
        tag: 'zeta/fp8',
        status: 0,
        throughput_last_30m: { p50: 30 },
        pricing: { completion: '0.000001' },
      },
      {
        provider_name: 'Offline',
        tag: 'offline/fp8',
        status: -5,
        throughput_last_30m: { p50: 999 },
        pricing: { completion: '0.0000001' },
      },
      {
        provider_name: 'NoPrice',
        tag: 'noprice/fp8',
        status: 0,
        throughput_last_30m: { p50: 5 },
        pricing: { completion: null },
      },
      {
        provider_name: 'Zero',
        tag: 'zero/fp8',
        status: 0,
        throughput_last_30m: { p50: 0 },
        pricing: { completion: '0.000001' },
      },
    ],
  },
};

test('OpenRouter selectors map to canonical endpoint model ids', () => {
  assert.equal(
    openRouterModel('openrouter/deepseek/deepseek-v4.1-flash-1017'),
    'deepseek/deepseek-v4.1-flash-1017',
  );
  assert.equal(
    openRouterModel('openrouter/deepseek/deepseek-v4.1-flash-1017:batch'),
    'deepseek/deepseek-v4.1-flash-1017',
  );
  assert.equal(openRouterModel('openrouter/~deepseek/deepseek-flash-latest'), undefined);
  assert.equal(openRouterModel('openrouter/deepseek'), undefined);
  assert.equal(openRouterModel('openrouter/deepseek/model@baseten'), undefined);
  assert.equal(openRouterModel('anthropic/claude'), undefined);
  assert.equal(openRouterModel('openrouter/deepseek/model/extra'), undefined);
});

test('routed selectors preserve the exact model and provider identity', () => {
  const selector = routeSelector('openrouter/deepseek/deepseek-v4.1-flash-1017', 'baseten');
  assert.equal(selector, 'openrouter/deepseek/deepseek-v4.1-flash-1017@baseten');
  assert.equal(routeBaseModel(selector), 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(routeProvider(selector), 'baseten');
  assert.throws(() => routeSelector('anthropic/claude', 'baseten'), /unavailable/);
  assert.throws(
    () => routeSelector('openrouter/deepseek/deepseek-v4.1-flash-1017', 'Not A Slug'),
    /Invalid/,
  );
});

test('provider parsing groups endpoints by slug and marks unavailable providers', () => {
  assert.deepEqual(parseOpenRouterProviders(endpoints), [
    {
      value: 'baseten',
      name: 'BaseTen',
      description: 'baseten, baseten/fast',
    },
    {
      value: 'nebius',
      name: 'Nebius',
      description: 'nebius/fp4',
    },
    {
      value: 'unavailable',
      name: 'Unavailable',
      description: 'unavailable/fp8 · unavailable',
    },
  ]);
  assert.deepEqual(parseOpenRouterProviders({ data: { endpoints: [] } }), []);
  assert.throws(() => parseOpenRouterProviders({}), /Invalid/);
  assert.throws(() => parseOpenRouterProviders([]), /Invalid/);
});

test('Optimal ranking uses each provider best throughput per completion price', () => {
  const parsed = parseOpenRouterProviders(rankedEndpoints);
  const baseten = parsed.find((option) => option.value === 'baseten');
  assert.ok(baseten);
  assert.equal(baseten.throughput, 60);
  assert.equal(baseten.completionPrice, 0.000002);
  assert.equal(parsed.find((option) => option.value === 'offline')?.throughput, undefined);
  assert.equal(parsed.find((option) => option.value === 'noprice')?.completionPrice, undefined);
  assert.equal(parsed.find((option) => option.value === 'zero')?.throughput, undefined);

  const optimal = optimalRoute(parsed);
  assert.ok(optimal);
  assert.equal(optimal.provider, 'scalar');
  assert.equal(optimal.name, 'Scalar');
  assert.equal(optimal.throughput, 30);
  assert.equal(optimal.completionPrice, 0.000001);
  assert.ok(Math.abs(optimal.score - 30_000_000) < 1);
});

test('Optimal ranking excludes missing metrics and breaks ties deterministically', () => {
  assert.equal(optimalRoute([]), undefined);
  assert.equal(optimalRoute([{ value: 'missing', name: 'Missing' }]), undefined);
  assert.equal(
    optimalRoute([{ value: 'zero', name: 'Zero', throughput: 0, completionPrice: 1 }]),
    undefined,
  );
  assert.equal(
    optimalRoute([{ value: 'bad', name: 'Bad', throughput: 1, completionPrice: Number.NaN }]),
    undefined,
  );
  assert.equal(
    optimalRoute([
      { value: 'zeta', name: 'Zeta', throughput: 10, completionPrice: 0.000001 },
      { value: 'beta', name: 'Beta', throughput: 10, completionPrice: 0.000002 },
      { value: 'alpha', name: 'Alpha', throughput: 10, completionPrice: 0.000001 },
      { value: 'alpha-2', name: 'Alpha', throughput: 10, completionPrice: 0.000001 },
    ])?.provider,
    'alpha',
  );
});

test('provider fetch is bounded, cached, and refuses failed responses', async () => {
  let calls = 0;
  let clock = 0;
  const requested: string[] = [];
  const request: typeof fetch = async (input, init) => {
    calls++;
    requested.push(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify(endpoints), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const routes = new OpenRouterRoutes(request, () => clock, 1000);
  assert.deepEqual(
    (await routes.providers('openrouter/deepseek/deepseek-v4.1-flash-1017')).map(
      (provider) => provider.value,
    ),
    ['baseten', 'nebius', 'unavailable'],
  );
  assert.match(
    requested[0]!,
    /^https:\/\/openrouter\.ai\/api\/v1\/models\/deepseek\/deepseek-v4\.1-flash-1017\/endpoints$/,
  );
  assert.equal(calls, 1);
  await routes.providers('openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(calls, 1);
  clock = 2000;
  await routes.providers('openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(calls, 2);
  await assert.rejects(
    routes.providers('openrouter/~deepseek/deepseek-flash-latest'),
    /unavailable/,
  );

  const failed = new OpenRouterRoutes(
    async () => new Response('nope', { status: 503 }),
    () => 0,
  );
  await assert.rejects(
    failed.providers('openrouter/deepseek/deepseek-v4.1-flash-1017'),
    /unavailable \(503\)/,
  );
  const malformed = new OpenRouterRoutes(
    async () => new Response('{not json', { status: 200 }),
    () => 0,
  );
  await assert.rejects(
    malformed.providers('openrouter/deepseek/deepseek-v4.1-flash-1017'),
    /invalid provider list/,
  );
  const empty = new OpenRouterRoutes(
    async () => new Response(JSON.stringify({ data: { endpoints: [] } }), { status: 200 }),
    () => 0,
  );
  await assert.rejects(
    empty.providers('openrouter/deepseek/deepseek-v4.1-flash-1017'),
    /No upstream providers/,
  );
});
