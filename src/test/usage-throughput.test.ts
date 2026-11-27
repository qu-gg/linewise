import assert from 'node:assert/strict';
import test from 'node:test';
import { updateTurn } from '../session-updates.js';
import { appendChunk, type Turn } from '../state.js';
import { markPromptSent, observedThroughput } from '../stream-metrics.js';

function runningTurn(): Turn {
  return {
    id: 'turn',
    prompt: 'measure me',
    status: 'running',
    startedAt: 100,
    blocks: [],
  };
}

test('agent text timing yields the documented character/4 estimate within tolerance', () => {
  const current = runningTurn();
  markPromptSent(current, 100);
  appendChunk(current, 'text', 'a'.repeat(40), 'text:first', { receivedAt: 500 });
  appendChunk(current, 'text', 'b'.repeat(40), 'text:first', { receivedAt: 1500 });
  const observed = observedThroughput(current);
  assert.ok(observed);
  assert.equal(observed.characters, 80);
  // 80 chars / 4 = 20 estimated tokens over 1000 ms of decode.
  assert.ok(Math.abs(observed.tokensPerSecond - 20) <= 20 * 0.005);
  // TTFT is prompt send (100) to the first text chunk (500).
  assert.equal(observed.ttftMs, 400);
  assert.equal(observed.stale, false);
});

test('thought and tool phases stay out of decode timing and character counts', () => {
  const current = runningTurn();
  markPromptSent(current, 100);
  appendChunk(current, 'thought', 'x'.repeat(5000), 'thought:one', { receivedAt: 200 });
  appendChunk(current, 'text', 'first', 'text:one', { receivedAt: 700 });
  appendChunk(current, 'text', ' more', 'text:one', { receivedAt: 900 });
  updateTurn(
    current,
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool',
      title: 'Run command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    } as Parameters<typeof updateTurn>[1],
    [],
  );
  appendChunk(current, 'thought', 'y'.repeat(5000), 'thought:two', { receivedAt: 1200 });
  appendChunk(current, 'text', 'tail', 'text:two', { receivedAt: 2000 });
  appendChunk(current, 'text', ' end', 'text:two', { receivedAt: 2200 });
  const observed = observedThroughput(current);
  assert.ok(observed);
  // Only the two adjacent text runs count: 200 ms + 200 ms.
  assert.equal(current.stream?.decodeMs, 400);
  assert.equal(observed.characters, 18);
  assert.equal(observed.ttftMs, 600);
  assert.ok(Math.abs(observed.tokensPerSecond - 4.5 / 0.4) <= 0.001);
});

test('missing, zero-output, and zero-duration streams stay unknown, never NaN', () => {
  assert.equal(observedThroughput(runningTurn()), undefined);
  const empty = runningTurn();
  appendChunk(empty, 'text', '', 'text:empty', { receivedAt: 500 });
  assert.equal(observedThroughput(empty), undefined);
  const missingTiming = runningTurn();
  missingTiming.stream = { characters: 80, lastTextAt: 1000 };
  assert.equal(observedThroughput(missingTiming), undefined);
  const zeroDuration = runningTurn();
  appendChunk(zeroDuration, 'text', 'abcd', 'text:one', { receivedAt: 1000 });
  appendChunk(zeroDuration, 'text', 'efgh', 'text:one', { receivedAt: 1000 });
  assert.equal(observedThroughput(zeroDuration), undefined);
  const nonFinite = runningTurn();
  nonFinite.stream = {
    characters: Number.POSITIVE_INFINITY,
    firstTextAt: 1,
    lastTextAt: 2,
    decodeMs: 1,
  };
  const observed = observedThroughput(nonFinite);
  assert.equal(observed, undefined);
});

test('finished and resumed turns expose the last observed value with a stale marker', () => {
  const current = runningTurn();
  markPromptSent(current, 100);
  appendChunk(current, 'text', 'a'.repeat(80), 'text:one', { receivedAt: 600 });
  appendChunk(current, 'text', 'b'.repeat(80), 'text:one', { receivedAt: 1600 });
  current.status = 'completed';
  current.endedAt = 2000;
  const observed = observedThroughput(current);
  assert.ok(observed);
  assert.equal(observed.stale, true);
  assert.ok(Number.isFinite(observed.tokensPerSecond));
  current.status = 'cancelled';
  assert.equal(observedThroughput(current)?.stale, true);
});
