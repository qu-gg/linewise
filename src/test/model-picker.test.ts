import test from 'node:test';
import assert from 'node:assert/strict';
import { groupModels, providerOf } from '../model-picker.js';

test('provider identifiers come from the first selector segment', () => {
  assert.equal(providerOf('openrouter/deepseek/deepseek-v4.1'), 'openrouter');
  assert.equal(providerOf('github-copilot/gpt-4.1'), 'github-copilot');
  assert.equal(providerOf('local'), 'unknown');
  assert.equal(providerOf('/leading'), 'unknown');
});

test('provider groups sort by model count and then case-insensitively by provider', () => {
  const groups = groupModels([
    { name: 'OpenRouter One', value: 'openrouter/one' },
    { name: 'Anthropic Two', value: 'anthropic/two' },
    { name: 'OpenRouter Two', value: 'openrouter/two' },
    { name: 'Copilot One', value: 'github-copilot/one' },
    { name: 'OpenRouter Three', value: 'openrouter/three' },
    { name: 'Anthropic One', value: 'anthropic/one' },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.provider, group.count]),
    [
      ['github-copilot', 1],
      ['anthropic', 2],
      ['openrouter', 3],
    ],
  );
  assert.deepEqual(
    groups[2]!.models.map((model) => model.value),
    ['openrouter/one', 'openrouter/two', 'openrouter/three'],
  );
});

test('equal provider counts stable-sort by lowercased provider name', () => {
  const groups = groupModels([
    { name: 'B', value: 'beta/model' },
    { name: 'A', value: 'Alpha/model' },
    { name: 'C', value: 'charlie/model' },
  ]);
  assert.deepEqual(
    groups.map((group) => group.provider),
    ['Alpha', 'beta', 'charlie'],
  );
});

test('empty catalogs and single-provider catalogs remain deterministic', () => {
  assert.deepEqual(groupModels([]), []);
  assert.deepEqual(
    groupModels([{ name: 'Only', value: 'solo/model', description: 'solo/model' }]),
    [
      {
        provider: 'solo',
        count: 1,
        models: [{ name: 'Only', value: 'solo/model', description: 'solo/model' }],
      },
    ],
  );
});
