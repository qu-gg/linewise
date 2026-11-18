import assert from 'node:assert/strict';
import test from 'node:test';
import { FollowUps, isQueueRequest } from '../follow-ups.js';

test('follow-ups drain in FIFO order with immutable snapshots and session ownership', async () => {
  const queue = new FollowUps();
  const attachments = [{ uri: 'file:///a', label: 'a', text: 'snapshot' }];
  queue.enqueue('one', 'first', attachments);
  attachments[0]!.text = 'later';
  queue.enqueue('one', 'second', []);
  assert.deepEqual(queue.snapshot('other').queued, []);
  assert.throws(() => queue.enqueue('other', 'foreign', []), /another session/);
  const first = queue.snapshot('one').queued[0]!;
  assert.throws(() => queue.remove('other', first.id), /this session/);
  const sent: string[] = [];
  await queue.drain(
    'other',
    () => true,
    async () => assert.fail('foreign drain'),
  );
  await queue.drain(
    'one',
    () => true,
    async (item) => {
      sent.push(item.text);
      if (item.text === 'first') assert.equal(item.attachments[0]!.text, 'snapshot');
      await queue.drain(
        'one',
        () => true,
        async () => assert.fail('concurrent drain'),
      );
    },
  );
  assert.deepEqual(sent, ['first', 'second']);
});

test('failure pauses remaining follow-ups and requires explicit resume; clear retires a drain', async () => {
  const queue = new FollowUps();
  queue.enqueue('one', 'first', []);
  queue.enqueue('one', 'second', []);
  await assert.rejects(
    queue.drain(
      'one',
      () => true,
      async () => {
        throw new Error('failed');
      },
    ),
    /failed/,
  );
  assert.equal(queue.snapshot('one').queuePaused, true);
  await queue.drain(
    'one',
    () => true,
    async () => assert.fail('paused'),
  );
  queue.resume();
  await queue.drain(
    'one',
    () => false,
    async () => assert.fail('not ready'),
  );
  assert.equal(queue.snapshot('one').queued.length, 1);
  queue.resume();
  await queue.drain(
    'one',
    () => true,
    async () => {
      queue.clear(true);
      queue.enqueue('two', 'new owner', []);
    },
  );
  assert.equal(queue.snapshot('two').queued.length, 1);
  queue.remove('two', queue.snapshot('two').queued[0]!.id);
  queue.settle('cancelled');
  queue.settle('completed');
  assert.equal(queue.snapshot('two').queuePaused, true);
  queue.clear();
  assert.equal(queue.snapshot('two').queuePaused, false);
});

test('follow-up bounds and reserved commands are enforced before queue mutation', () => {
  const queue = new FollowUps();
  assert.throws(() => queue.enqueue('one', '', []), /Invalid/);
  assert.throws(() => queue.enqueue('one', 'x'.repeat(128_001), []), /Invalid/);
  assert.throws(
    () =>
      queue.enqueue('one', 'large', [{ uri: 'file:///a', label: 'a', text: 'x'.repeat(512_000) }]),
    /limit/,
  );
  for (let index = 0; index < 5; index++) queue.enqueue('one', `prompt ${index}`, []);
  assert.throws(() => queue.enqueue('one', 'six', []), /limit/);
  assert.equal(isQueueRequest({ type: 'queuePrompt' }), true);
  assert.equal(isQueueRequest({ type: 'prompt' }), false);
});
