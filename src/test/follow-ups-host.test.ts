import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';

test('host queues serial follow-ups, allows removal and clears pending work on Stop', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await assert.rejects(host.request({ type: 'queuePrompt', text: 'idle' }), /running prompt/);
  const sent: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.onPrompt = async (blocks) => {
    const text = blocks[0]!.type === 'text' ? blocks[0]!.text : '';
    sent.push(text);
    if (text === 'first') {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  };
  const pending = host.request({ type: 'prompt', text: 'first' });
  await started;
  await host.request({ type: 'queuePrompt', text: 'second' });
  await host.request({ type: 'queuePrompt', text: 'remove' });
  await host.request({ type: 'removeQueued', id: host.status()!.queued[1]!.id });
  await assert.rejects(host.request({ type: 'resumeQueue' }), /current operation/);
  assert.deepEqual(sent, ['first']);
  release();
  await pending;
  assert.deepEqual(sent, ['first', 'second']);
  assert.equal(host.status()!.turns.length, 2);
  const nextStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopped = host.request({ type: 'prompt', text: 'first' });
  await nextStarted;
  await host.request({ type: 'queuePrompt', text: 'never' });
  transport.onCancel = () => release();
  await host.request({ type: 'cancel' });
  await stopped;
  assert.equal(sent.includes('never'), false);
  assert.deepEqual(host.status()!.queued, []);
});

test('host pauses after failed follow-up, resumes explicitly and never carries queue across sessions', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.onPrompt = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const pending = host.request({ type: 'prompt', text: 'first' });
  await started;
  await host.request({ type: 'queuePrompt', text: 'failed' });
  await host.request({ type: 'queuePrompt', text: 'remaining' });
  transport.onPrompt = async () => {
    throw new Error('provider failed');
  };
  release();
  await assert.rejects(pending, /provider failed/);
  assert.equal(host.status()!.queuePaused, true);
  assert.equal(host.status()!.queued[0]!.text, 'remaining');
  transport.onPrompt = async () => {};
  await host.request({ type: 'resumeQueue' });
  assert.equal(host.status()!.turns.at(-1)!.prompt, 'remaining');
  await host.request({ type: 'clearQueue' });
  await host.request({ type: 'new' });
  assert.deepEqual(host.status()!.queued, []);
});
