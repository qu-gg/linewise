import assert from 'node:assert/strict';
import test from 'node:test';
import { Attention, type AttentionPolicy } from '../attention.js';

const policy: AttentionPolicy = {
  enabled: true,
  approval: true,
  questions: true,
  finished: true,
  backgroundOnly: true,
};
const running = { sessionId: 'owner', busy: true, turns: [{ id: 'turn', status: 'running' }] };

test('attention is generic, request-deduplicated and never grants, submits or replays completion', () => {
  const attention = new Attention();
  assert.deepEqual(attention.observe({}, policy, false), []);
  const complete = { ...running, busy: false, turns: [{ id: 'old', status: 'completed' }] };
  assert.deepEqual(attention.observe(complete, policy, false), []);
  const pending = {
    ...running,
    approval: { id: 'approval', summary: 'secret command' },
    question: { id: 'question', question: 'private question' },
  };
  const events = attention.observe(pending, policy, false);
  assert.deepEqual(events, [
    { kind: 'approval', sessionId: 'owner', id: 'approval' },
    { kind: 'questions', sessionId: 'owner', id: 'question' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret|private/);
  assert.deepEqual(attention.observe(pending, policy, false), []);
  assert.equal(attention.current(events[0]!, pending), true);
  assert.equal(attention.current(events[1]!, { ...pending, sessionId: 'foreign' }), false);
  assert.equal(attention.current(events[0]!, { ...running }), false);
});

test('successful workflow completion coalesces queued turns and excludes failure, Stop and history replay', () => {
  const attention = new Attention();
  attention.observe(running, policy, false);
  const completed = { ...running, busy: false, turns: [{ id: 'turn', status: 'completed' }] };
  assert.deepEqual(attention.observe({ ...completed, queued: [{}] }, policy, false), []);
  assert.deepEqual(
    attention.observe({ ...completed, error: 'final save failed' }, policy, false),
    [],
  );
  const event = attention.observe(completed, policy, false)[0]!;
  assert.equal(event.kind, 'finished');
  assert.equal(attention.current(event, completed), true);
  assert.equal(attention.current(event, running), false);
  assert.deepEqual(attention.observe(completed, policy, false), []);
  for (const status of ['failed', 'cancelled']) {
    const next = new Attention();
    next.observe(running, policy, false);
    assert.deepEqual(
      next.observe({ ...completed, turns: [{ id: 'turn', status }] }, policy, false),
      [],
    );
  }
});

test('global, event and foreground suppression do not later replay suppressed notifications', () => {
  for (const settings of [{ ...policy, enabled: false }, { ...policy, approval: false }, policy]) {
    const attention = new Attention();
    const pending = { ...running, approval: { id: 'request' } };
    assert.deepEqual(attention.observe(pending, settings, true), []);
    assert.deepEqual(attention.observe(pending, policy, false), []);
  }
  const attention = new Attention();
  assert.equal(
    attention.observe(
      { ...running, approval: { id: 'new' } },
      { ...policy, backgroundOnly: false },
      true,
    ).length,
    1,
  );
});
