import assert from 'node:assert/strict';
import test from 'node:test';
import { actionableChange } from '../review-actionable.js';
import type { Change } from '../review-types.js';

function change(overrides: Partial<Change> = {}): Change {
  return {
    id: 'change',
    sessionId: 'session',
    path: '/workspace/file.ts',
    before: 'before\n',
    after: 'after\n',
    state: 'pending',
    updatedAt: 1,
    ...overrides,
  };
}

test('only live non-identical pending changes are actionable', () => {
  assert.equal(actionableChange(change()), true);
  assert.equal(actionableChange(change({ before: 'same\n', after: 'same\n' })), false);
  assert.equal(actionableChange(change({ state: 'conflict' })), false);
  assert.equal(actionableChange(change({ state: 'applying' })), false);
  assert.equal(actionableChange(change({ before: null, after: 'created\n' })), true);
  assert.equal(actionableChange(change({ before: 'deleted\n', after: null })), true);
  assert.equal(
    actionableChange(
      change({
        before: 'source\n',
        after: null,
        destination: { path: '/workspace/destination.ts', before: null, after: 'source\n' },
      }),
    ),
    true,
  );
});
