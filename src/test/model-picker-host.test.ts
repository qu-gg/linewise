import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { picker } from './quick-pick-fixture.js';

test('host selects advertised provider models and switches through the native picker', async (context) => {
  const host = await setup(context);
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options: [
        { name: 'DeepSeek', value: 'openrouter/deepseek', description: 'openrouter/deepseek' },
        { name: 'Qwen', value: 'openrouter/qwen', description: 'openrouter/qwen' },
        { name: 'Claude', value: 'anthropic/claude', description: 'anthropic/claude' },
      ],
    },
  ];
  await host.request({ type: 'connect' });
  const model = transport.client!.configOptions.find((option) => option.id === 'model')!;
  assert.equal(model.currentValue, 'openrouter/deepseek');
  fixture.quickPick = 'anthropic/claude';
  await host.request({ type: 'pickModel' });
  assert.equal(model.currentValue, 'anthropic/claude');
  assert.deepEqual(
    picker.items.filter((item) => item.value).map((item) => item.value),
    ['anthropic/claude', 'openrouter/deepseek', 'openrouter/qwen'],
  );
  assert.deepEqual(
    picker.items.filter((item) => item.kind === -1).map((item) => item.label),
    ['anthropic (1)', 'openrouter (2)'],
  );
  await host.request({ type: 'pickModel' });
  assert.equal(model.currentValue, 'anthropic/claude');
  fixture.quickPick = undefined;
  await host.request({ type: 'pickModel' });
  assert.equal(model.currentValue, 'anthropic/claude');
});

test('host seeds the first session from omp.model', async (context) => {
  const host = await setup(context);
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options: [
        { name: 'DeepSeek', value: 'openrouter/deepseek' },
        { name: 'Claude', value: 'anthropic/claude' },
      ],
    },
  ];
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
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options,
    },
  ];
  await host.request({ type: 'connect' });
  fixture.quickPick = 'anthropic/claude';
  await host.request({ type: 'pickModel' });
  assert.equal(host.storedState!().lastModel, 'anthropic/claude');
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options,
    },
  ];
  await host.request({ type: 'new' });
  assert.equal(
    transport.client!.configOptions.find((option) => option.id === 'model')!.currentValue,
    'anthropic/claude',
  );
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options: [{ name: 'DeepSeek', value: 'openrouter/deepseek' }],
    },
  ];
  await host.request({ type: 'new' });
  assert.equal(
    transport.client!.configOptions.find((option) => option.id === 'model')!.currentValue,
    'openrouter/deepseek',
  );
});

test('host rejects an unavailable omp.model before the first session', async (context) => {
  const host = await setup(context);
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options: [{ name: 'DeepSeek', value: 'openrouter/deepseek' }],
    },
  ];
  fixture.configuration.set('omp.model', 'openrouter/deepseek@nebius');
  await assert.rejects(host.request({ type: 'connect' }), /not an advertised OMP model/);
});

test('picker exposes thinking configuration and handles an empty model catalog', async (context) => {
  const host = await setup(context);
  transport.configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'openrouter/deepseek',
      options: [{ name: 'DeepSeek', value: 'openrouter/deepseek' }],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      type: 'select',
      currentValue: 'high',
      options: [{ name: 'High', value: 'high' }],
    },
  ];
  await host.request({ type: 'connect' });
  assert.deepEqual(host.status()!.configs.find((config) => config.id === 'thinking')!.options, [
    { name: 'High', value: 'high' },
  ]);
  const model = transport.client!.configOptions.find((option) => option.id === 'model')!;
  if (model.type !== 'select') throw new Error('Expected a model selector.');
  model.options = [];
  await host.request({ type: 'pickModel' });
  assert.deepEqual(picker.items, []);
  transport.client!.configOptions = [];
  await host.request({ type: 'pickModel' });
  assert.deepEqual(picker.items, []);
});
