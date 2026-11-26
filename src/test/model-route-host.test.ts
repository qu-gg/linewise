import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { fixture } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';

const providerResponse = {
  data: {
    endpoints: [
      { provider_name: 'BaseTen', tag: 'baseten/fast', status: 0 },
      { provider_name: 'Nebius', tag: 'nebius/fp4', status: 0 },
    ],
  },
};
const originalFetch = globalThis.fetch;
let mode: 'ok' | 'fail' = 'ok';
const requests: string[] = [];

globalThis.fetch = (async (input) => {
  requests.push(String(input));
  if (mode === 'fail') return new Response('unavailable', { status: 503 });
  return new Response(JSON.stringify(providerResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function modelCatalog(
  options: { name: string; value: string }[],
  currentValue = 'openrouter/deepseek/deepseek-v4.1-flash-1017',
) {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select' as const,
      currentValue,
      options,
    },
  ];
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await tick();
  }
}

test('new-chat route catalog applies an upstream pin through the OMP launch model', async (context) => {
  requests.length = 0;
  mode = 'ok';
  const host = await setup(context);
  transport.nextSessionId = 'initial-session';
  transport.configOptions = modelCatalog([
    {
      name: 'DeepSeek V4.1 Flash 1017',
      value: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    },
  ]);
  await host.request({ type: 'connect' });
  await waitFor(
    () => host.status()!.modelRoute.options.length > 1,
    'route catalog was not published',
  );
  assert.deepEqual(
    host.status()!.modelRoute.options.map((option) => option.value),
    ['auto', 'baseten', 'nebius'],
  );
  assert.match(requests[0]!, /deepseek\/deepseek-v4\.1-flash-1017\/endpoints$/);

  await host.request({ type: 'modelRoute', value: 'baseten' });
  assert.equal(host.status()!.modelRoute.value, 'baseten');
  assert.equal(host.status()!.configs.find((config) => config.id === 'model')!.route, undefined);

  const initialSessions = host.storedState!().sessions.length;
  assert.equal(initialSessions, 1);
  transport.nextSessionId = 'routed-session';
  await host.request({ type: 'prompt', text: 'route this chat' });
  assert.ok(transport.started!.args.includes('--model'));
  assert.equal(
    transport.started!.args[transport.started!.args.indexOf('--model') + 1],
    'openrouter/deepseek/deepseek-v4.1-flash-1017@baseten',
  );
  assert.equal(host.status()!.turns.length, 1);
  assert.equal(host.status()!.modelRoute.visible, false);
  assert.equal(host.storedState!().sessions.length, 1);
  assert.equal(host.storedState!().sessions[0]!.id, 'routed-session');
  assert.equal(host.storedState!().lastModel, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(
    host.status()!.configs.find((config) => config.id === 'model')!.route?.label,
    'BaseTen',
  );
  await assert.rejects(host.request({ type: 'modelRoute', value: 'nebius' }), /new chat/);
});

test('changing the model clears its pending route and non-OpenRouter models hide the picker', async (context) => {
  requests.length = 0;
  mode = 'ok';
  const host = await setup(context);
  transport.nextSessionId = 'model-change-session';
  transport.configOptions = modelCatalog([
    {
      name: 'DeepSeek V4.1 Flash 1017',
      value: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    },
    { name: 'Qwen3.8 Flash', value: 'openrouter/qwen/qwen3.8-flash' },
    { name: 'Claude', value: 'anthropic/claude' },
  ]);
  await host.request({ type: 'connect' });
  await waitFor(
    () => host.status()!.modelRoute.options.length > 1,
    'route catalog was not published',
  );
  await host.request({ type: 'modelRoute', value: 'nebius' });
  assert.equal(host.status()!.modelRoute.value, 'nebius');
  await host.request({
    type: 'config',
    id: 'model',
    value: 'openrouter/qwen/qwen3.8-flash',
  });
  assert.equal(host.status()!.modelRoute.value, 'auto');
  assert.equal(host.status()!.configs.find((config) => config.id === 'model')!.route, undefined);
  await waitFor(
    () => host.status()!.modelRoute.options.length > 1,
    'route catalog did not refresh',
  );
  assert.match(requests.at(-1)!, /qwen\/qwen3\.8-flash\/endpoints$/);

  await host.request({ type: 'config', id: 'model', value: 'anthropic/claude' });
  assert.equal(host.status()!.modelRoute.visible, false);
});

test('provider lookup failure keeps Auto available and does not block connection', async (context) => {
  mode = 'fail';
  const host = await setup(context);
  transport.nextSessionId = 'failed-lookup-session';
  transport.configOptions = modelCatalog([
    {
      name: 'DeepSeek V4.1 Flash 1017',
      value: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    },
  ]);
  await host.request({ type: 'connect' });
  await waitFor(() => host.status()!.modelRoute.error !== '', 'provider failure was not published');
  assert.equal(host.status()!.modelRoute.visible, false);
  assert.match(host.status()!.modelRoute.error, /unavailable \(503\)/);
  await assert.rejects(host.request({ type: 'modelRoute', value: 'baseten' }), /current route/);
  mode = 'ok';
});

test('New Session clears a pending route and uses Auto routing', async (context) => {
  mode = 'ok';
  const host = await setup(context);
  transport.nextSessionId = 'new-route-session';
  transport.configOptions = modelCatalog([
    {
      name: 'DeepSeek V4.1 Flash 1017',
      value: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    },
  ]);
  fixture.configuration.set('omp.model', 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  await host.request({ type: 'connect' });
  await waitFor(
    () => host.status()!.modelRoute.options.length > 1,
    'route catalog was not published',
  );
  await host.request({ type: 'modelRoute', value: 'baseten' });
  assert.equal(host.status()!.modelRoute.value, 'baseten');
  await host.request({ type: 'new' });
  assert.equal(host.status()!.modelRoute.value, 'auto');
  assert.equal(transport.started!.args.includes('--model'), false);
});
