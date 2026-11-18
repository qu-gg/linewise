import assert from 'node:assert/strict';
import test from 'node:test';
import { Approvals } from '../approvals.js';
import type { ApprovalPrompt } from '../approvals.js';

function prompt(summary = 'echo hello'): ApprovalPrompt {
  return {
    kind: 'command',
    title: 'Run command?',
    summary,
    details: 'Exact command details',
    notice: 'Not sandboxed',
  };
}

test('approvals capture immutable snapshots and resolve only the visible request once', async () => {
  let changes = 0;
  const approvals = new Approvals(() => changes++);
  const input = prompt();
  const first = approvals.request(input, new AbortController().signal, () => true);
  input.summary = 'changed';
  const visible = approvals.snapshot().approval!;
  visible.summary = 'forged display';
  assert.equal(approvals.snapshot().approval!.summary, 'echo hello');
  const second = approvals.request(prompt('second'), new AbortController().signal, () => true);
  approvals.decide('unknown', true);
  assert.equal(approvals.snapshot().approvalCount, 2);
  approvals.decide(visible.id, true);
  assert.equal(await first, true);
  approvals.decide(visible.id, true);
  assert.equal(approvals.snapshot().approval!.summary, 'second');
  approvals.decide(approvals.snapshot().approval!.id, false);
  assert.equal(await second, false);
  approvals.cancel();
  assert.deepEqual(approvals.snapshot(), { approval: undefined, approvalCount: 0 });
  assert.equal(changes, 4);
});

test('aborts remove queued approvals and late decisions cannot approve a successor', async () => {
  const approvals = new Approvals(() => {});
  const active = new AbortController();
  const queued = new AbortController();
  const first = approvals.request(prompt(), active.signal, () => true);
  const stale = approvals.snapshot().approval!.id;
  const second = approvals.request(prompt('queued'), queued.signal, () => true);
  queued.abort();
  assert.equal(await second, false);
  assert.equal(approvals.snapshot().approvalCount, 1);
  active.abort();
  assert.equal(await first, false);
  const third = approvals.request(prompt('new'), new AbortController().signal, () => true);
  approvals.decide(stale, true);
  assert.equal(approvals.snapshot().approval!.summary, 'new');
  approvals.cancel();
  assert.equal(await third, false);
});

test('invalid owners, aborted signals and overflowing queues fail closed', async () => {
  const approvals = new Approvals(() => {});
  const aborted = AbortSignal.abort();
  assert.equal(await approvals.request(prompt(), aborted, () => true), false);
  assert.equal(await approvals.request(prompt(), new AbortController().signal, () => false), false);
  const throwing = () => {
    throw new Error('retired');
  };
  assert.equal(await approvals.request(prompt(), new AbortController().signal, throwing), false);
  const pending = Array.from({ length: 8 }, () =>
    approvals.request(prompt(), new AbortController().signal, () => true),
  );
  assert.equal(await approvals.request(prompt(), new AbortController().signal, () => true), false);
  approvals.cancel();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(false));
});

test('ownership is checked again on Allow, including throwing validators', async () => {
  const approvals = new Approvals(() => {});
  let valid = true;
  const first = approvals.request(prompt(), new AbortController().signal, () => valid);
  valid = false;
  approvals.decide(approvals.snapshot().approval!.id, true);
  assert.equal(await first, false);
  let retired = false;
  const second = approvals.request(prompt(), new AbortController().signal, () => {
    if (retired) throw new Error('retired');
    return true;
  });
  retired = true;
  approvals.decide(approvals.snapshot().approval!.id, true);
  assert.equal(await second, false);
});

test('synchronous cancellation during publication cannot leave a pending request', async () => {
  const signal = new AbortController();
  const approvals = new Approvals(() => signal.abort());
  assert.equal(await approvals.request(prompt(), signal.signal, () => true), false);
  assert.equal(approvals.snapshot().approvalCount, 0);
});
