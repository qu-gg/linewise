import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';

interface CatalogMessage {
  v: number;
  type: string;
  groups?: { provider: string; count: number; models: { name: string; value: string }[] }[];
  current?: string;
}

function modelCatalog(
  options: { name: string; value: string; description?: string }[],
  currentValue = 'openrouter/deepseek',
) {
  return [{ id: 'model', name: 'Model', type: 'select' as const, currentValue, options }];
}

function lastCatalog(): CatalogMessage {
  const message = (fixture.messages as CatalogMessage[])
    .filter((candidate) => candidate.type === 'modelCatalog')
    .at(-1);
  assert.ok(message, 'model catalog was not published');
  return message;
}

test('host publishes grouped provider catalogs and applies selected models', async (context) => {
  const host = await setup(context);
  transport.configOptions = [
    ...modelCatalog([
      { name: 'DeepSeek', value: 'openrouter/deepseek', description: 'openrouter/deepseek' },
      { name: 'Qwen', value: 'openrouter/qwen', description: 'openrouter/qwen' },
      { name: 'Claude', value: 'anthropic/claude', description: 'anthropic/claude' },
    ]),
    {
      id: 'thinking',
      name: 'Thinking',
      type: 'select' as const,
      currentValue: 'high',
      options: [{ name: 'High', value: 'high' }],
    },
  ];
  await host.request({ type: 'connect' });
  assert.deepEqual(host.status()!.configs.find((config) => config.id === 'thinking')!.options, [
    { name: 'High', value: 'high' },
  ]);
  const model = transport.client!.configOptions.find((option) => option.id === 'model')!;
  await host.request({ type: 'modelCatalog' });
  const catalog = lastCatalog();
  assert.equal(catalog.current, 'openrouter/deepseek');
  assert.deepEqual(
    catalog.groups!.map((group) => [group.provider, group.count]),
    [
      ['anthropic', 1],
      ['openrouter', 2],
    ],
  );
  assert.deepEqual(
    catalog.groups!.flatMap((group) => group.models.map((choice) => choice.value)),
    ['anthropic/claude', 'openrouter/deepseek', 'openrouter/qwen'],
  );
  await host.request({ type: 'config', id: 'model', value: 'anthropic/claude' });
  assert.equal(model.currentValue, 'anthropic/claude');
});

test('host seeds the first session from omp.model', async (context) => {
  const host = await setup(context);
  transport.configOptions = modelCatalog([
    { name: 'DeepSeek', value: 'openrouter/deepseek' },
    { name: 'Claude', value: 'anthropic/claude' },
  ]);
  fixture.configuration.set('omp.model', 'anthropic/claude');
  await host.request({ type: 'connect' });
  assert.equal(
    transport.client!.configOptions.find((option) => option.id === 'model')!.currentValue,
    'anthropic/claude',
  );
  assert.equal(host.storedState!().lastModel, 'anthropic/claude');
});

test('new sessions reuse the last active model', async (context) => {
  const host = await setup(context);
  const options = [
    { name: 'DeepSeek', value: 'openrouter/deepseek' },
    { name: 'Claude', value: 'anthropic/claude' },
  ];
  transport.configOptions = modelCatalog(options);
  await host.request({ type: 'connect' });
  await host.request({ type: 'config', id: 'model', value: 'anthropic/claude' });
  assert.equal(host.storedState!().lastModel, 'anthropic/claude');
  transport.configOptions = modelCatalog(options);
  await host.request({ type: 'new' });
  assert.equal(
    transport.client!.configOptions.find((option) => option.id === 'model')!.currentValue,
    'anthropic/claude',
  );
  transport.configOptions = modelCatalog([{ name: 'DeepSeek', value: 'openrouter/deepseek' }]);
  await host.request({ type: 'new' });
  assert.equal(
    transport.client!.configOptions.find((option) => option.id === 'model')!.currentValue,
    'openrouter/deepseek',
  );
});

test('host rejects an unavailable omp.model before the first session', async (context) => {
  const host = await setup(context);
  transport.configOptions = modelCatalog([{ name: 'DeepSeek', value: 'openrouter/deepseek' }]);
  fixture.configuration.set('omp.model', 'openrouter/deepseek@nebius');
  await assert.rejects(host.request({ type: 'connect' }), /not an advertised OMP model/);
});

test('host publishes an empty catalog when models are unavailable', async (context) => {
  const host = await setup(context);
  transport.configOptions = modelCatalog([
    { name: 'DeepSeek', value: 'openrouter/deepseek' },
    { name: 'Claude', value: 'anthropic/claude' },
  ]);
  await host.request({ type: 'connect' });
  const model = transport.client!.configOptions.find((option) => option.id === 'model')!;
  if (model.type !== 'select') throw new Error('Expected a model selector.');
  model.options = [];
  await host.request({ type: 'modelCatalog' });
  assert.deepEqual(lastCatalog().groups, []);
  transport.client!.configOptions = [];
  await host.request({ type: 'modelCatalog' });
  assert.deepEqual(lastCatalog().groups, []);
});
