import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, messages, message, update, element, click } from './webview-setup.js';

test('inline model picker groups providers, searches and selects with keyboard', () => {
  update({
    configs: [
      {
        id: 'model',
        name: 'Model',
        value: 'openrouter/deepseek',
        label: 'DeepSeek <V4.1>',
        provider: 'openrouter',
      },
    ],
  });
  const model = element<HTMLButtonElement>('#model-picker');
  assert.equal(model.getAttribute('aria-label'), 'Model: DeepSeek <V4.1>');
  assert.equal(model.title, 'openrouter/deepseek');
  assert.match(model.textContent!, /DeepSeek <V4\.1>/);
  click('pickModel');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'modelCatalog' });
  message({
    type: 'modelCatalog',
    current: 'openrouter/deepseek',
    groups: [
      {
        provider: 'anthropic',
        count: 1,
        models: [{ name: 'Claude', value: 'anthropic/claude' }],
      },
      {
        provider: 'openrouter',
        count: 2,
        models: [
          { name: 'DeepSeek', value: 'openrouter/deepseek' },
          { name: 'Qwen', value: 'openrouter/qwen' },
        ],
      },
    ],
  });
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.model-provider span:first-child')].map(
      (node) => node.textContent,
    ),
    ['anthropic', 'openrouter'],
  );
  assert.equal(element('.model-option.active').getAttribute('data-model'), 'openrouter/deepseek');
  assert.equal(element('[data-model="openrouter/deepseek"]').getAttribute('aria-selected'), 'true');
  let search = element<HTMLInputElement>('#model-search');
  search.value = 'qwen';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll('[data-model]').length, 1);
  assert.equal(element('.model-option').getAttribute('data-model'), 'openrouter/qwen');
  search = element<HTMLInputElement>('#model-search');
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(messages.at(-1), {
    v: 1,
    type: 'config',
    id: 'model',
    value: 'openrouter/qwen',
  });
  assert.equal(dom.window.document.querySelector('#model-search'), null);
});

test('inline model picker closes on Escape or outside click and reports empty catalogs', () => {
  update({
    configs: [
      {
        id: 'model',
        name: 'Model',
        value: 'openrouter/deepseek',
        label: 'DeepSeek',
        provider: 'openrouter',
      },
    ],
  });
  click('pickModel');
  message({
    type: 'modelCatalog',
    current: 'openrouter/deepseek',
    groups: [
      {
        provider: '<provider>',
        count: 1,
        models: [{ name: '<b>Model</b>', value: 'openrouter/deepseek' }],
      },
    ],
  });
  assert.equal(dom.window.document.querySelector('b'), null);
  assert.match(element('[data-model="openrouter/deepseek"]').textContent!, /<b>Model<\/b>/);
  element<HTMLInputElement>('#model-search').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  message({ type: 'noop' });
  assert.equal(dom.window.document.querySelector('#model-search'), null);
  assert.equal(dom.window.document.activeElement, element('#model-picker'));
  click('pickModel');
  message({ type: 'modelCatalog', current: '', groups: [] });
  assert.match(element('.model-empty').textContent!, /login/);
  dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(dom.window.document.querySelector('#model-search'), null);
});

test('thinking selector retains native accessibility and busy controls disable the picker', () => {
  update({
    configs: [
      {
        id: 'model',
        name: 'Model',
        value: 'openrouter/deepseek',
        label: 'DeepSeek',
        provider: 'openrouter',
      },
      {
        id: 'thinking',
        name: 'Thinking',
        value: 'high',
        options: [
          { name: 'Extra High', value: 'high' },
          { name: 'Medium', value: 'medium' },
        ],
      },
    ],
  });
  const thinking = element<HTMLSelectElement>('[data-config="thinking"]');
  assert.equal(thinking.getAttribute('aria-label'), 'Thinking');
  thinking.value = 'medium';
  thinking.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(messages.at(-1), { v: 1, type: 'config', id: 'thinking', value: 'medium' });
  update({ busy: true });
  assert.equal(element<HTMLButtonElement>('#model-picker').disabled, true);
  assert.equal(element<HTMLSelectElement>('[data-config="thinking"]').disabled, true);
  update({ busy: false });
});
