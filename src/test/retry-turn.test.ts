import test from 'node:test';
import assert from 'node:assert/strict';
import { retryLastTurn, type RetryView } from '../retry-turn.js';
import type { SavedSession } from '../state.js';

function session(overrides: Record<string, unknown> = {}) {
  return {
    turns: [
      { id: 'last', prompt: 'Try again', status: 'completed' },
      ...((overrides.turns as object[] | undefined) ?? []),
    ],
  } as unknown as SavedSession;
}

function view(current: SavedSession | undefined) {
  const branches: { id: string; prompt: string }[] = [];
  const value: RetryView = {
    active: () => current,
    editPrompt: async (id, branch) => {
      assert.equal(id, current?.turns.at(-1)?.id);
      await branch();
    },
  };
  return {
    value,
    branches,
    run: (id: string) =>
      retryLastTurn(value, id, async (id, prompt) => {
        branches.push({ id, prompt });
      }),
  };
}

test('retry resends the last completed prompt without changing the turn identity', async () => {
  const current = session();
  const harness = view(current);
  await harness.run('last');
  assert.deepEqual(harness.branches, [{ id: 'last', prompt: 'Try again' }]);
});

test('retry refuses missing, stale and incomplete turns without editing history', async () => {
  await assert.rejects(view(undefined).run('last'), /last completed response/);
  await assert.rejects(view(session()).run('other'), /last completed response/);
  await assert.rejects(
    view(
      session({
        turns: [{ id: 'last', prompt: 'Try again', status: 'running' }],
      }),
    ).run('last'),
    /last completed response/,
  );
  await assert.rejects(
    view(session({ turns: [{ id: 'last', prompt: '   ', status: 'completed' }] })).run('last'),
    /last completed response/,
  );
});
