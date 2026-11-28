import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, messages, update, element, turn } from './webview-setup.js';

const model = {
  id: 'model',
  name: 'Model',
  value: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
  label: 'DeepSeek V4.1 Flash 1017',
  provider: 'openrouter',
};

const routes = [
  { value: 'auto', name: 'Auto (OpenRouter)', description: 'OpenRouter default routing' },
  {
    value: 'optimal',
    name: 'Optimal',
    description: 'BaseTen · 60.0 tok/s · $2.00/M completion',
  },
  { value: 'baseten', name: 'BaseTen', description: 'baseten, baseten/fast' },
  { value: 'nebius', name: 'Nebius', description: 'nebius/fp4' },
];

test('new-chat route picker renders providers and sends the selected pin', () => {
  update({
    configs: [model],
    modelRoute: {
      visible: true,
      value: 'auto',
      options: routes,
      loading: false,
      error: '',
    },
  });
  const select = element<HTMLSelectElement>('#model-route');
  assert.equal(select.getAttribute('aria-label'), 'OpenRouter provider');
  assert.equal(select.value, 'auto');
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['auto', 'optimal', 'baseten', 'nebius'],
  );
  assert.match(select.title, /OpenRouter default routing/);
  select.value = 'optimal';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(messages.at(-1), { v: 1, type: 'modelRoute', value: 'optimal' });
  select.value = 'baseten';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(messages.at(-1), { v: 1, type: 'modelRoute', value: 'baseten' });

  update({
    modelRoute: {
      visible: true,
      value: 'baseten',
      options: routes,
      loading: false,
      error: '',
    },
  });
  assert.match(element('#model-picker').textContent!, /via BaseTen/);
  assert.equal(element('#model-route').getAttribute('title'), 'baseten, baseten/fast');
});

test('Optimal is disabled when no provider metrics are available', () => {
  update({
    configs: [model],
    modelRoute: {
      visible: true,
      value: 'auto',
      options: [
        routes[0],
        {
          value: 'optimal',
          name: 'Optimal',
          description: 'No provider reports both 30-minute throughput and completion price.',
          disabled: true,
        },
        routes[2],
      ],
      loading: false,
      error: '',
    },
  });
  const select = element<HTMLSelectElement>('#model-route');
  const optimal = [...select.options].find((option) => option.value === 'optimal');
  assert.ok(optimal);
  assert.equal(optimal.disabled, true);
  assert.match(optimal.title, /No provider reports both/);
  assert.equal(select.value, 'auto');
});

test('route picker is disabled while working and hidden when provider lookup fails', () => {
  update({
    configs: [model],
    busy: true,
    modelRoute: {
      visible: true,
      value: 'auto',
      options: routes,
      loading: false,
      error: '',
    },
  });
  assert.equal(element<HTMLSelectElement>('#model-route').disabled, true);
  update({
    busy: false,
    modelRoute: {
      visible: false,
      value: 'auto',
      options: [],
      loading: false,
      error: 'OpenRouter provider list is unavailable (503).',
    },
  });
  assert.equal(dom.window.document.querySelector('#model-route'), null);
  assert.equal(element('#model-picker').textContent!.includes('via'), false);
});

test('an applied route stays visible on the model control after the first turn', () => {
  update({
    configs: [{ ...model, route: { provider: 'baseten', label: 'Optimal · BaseTen' } }],
    turns: [turn()],
    modelRoute: { visible: false, value: 'auto', options: [], loading: false, error: '' },
  });
  assert.match(element('#model-picker').textContent!, /via Optimal · BaseTen/);
  assert.equal(dom.window.document.querySelector('#model-route'), null);
});
