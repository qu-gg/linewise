import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { Document, fixture, seedFile, Uri } from './vscode-fixture.js';
import { StateStore, type SavedSession, type Turn } from '../state.js';
import type { HistorySnapshot } from '../history.js';
import { applyCompactionUsage } from '../session-presentation.js';

function usageFixture() {
  const current: Turn = {
    id: 'control',
    prompt: '/compact',
    status: 'completed',
    startedAt: 1,
    blocks: [],
  };
  const session: SavedSession = {
    id: 'logical-owner',
    root: 'file:///workspace',
    label: 'Usage',
    turns: [current],
    usage: { used: 800, size: 1000, cost: { amount: 2.5, currency: 'USD' }, stale: true },
  };
  const before: HistorySnapshot = {
    sessionId: 'native-owner',
    leafId: 'previous',
    entries: [{ id: 'previous', parentId: null, type: 'message', role: 'assistant' }],
  };
  const after: HistorySnapshot = {
    ...before,
    leafId: 'summary',
    contextUsage: { tokens: 200.5, contextWindow: 1000 },
    entries: [...before.entries, { id: 'summary', parentId: 'previous', type: 'compaction' }],
  };
  return { session, current, before, after };
}

for (const prompt of ['/compact', 'Continue normally after automatic compaction']) {
  test(`newly committed native compaction refreshes usage for ${prompt} without changing prompt, cost or identity`, () => {
    const { session, current, before, after } = usageFixture();
    current.prompt = prompt;
    applyCompactionUsage(session, current, before, after);
    assert.deepEqual(session.usage, {
      used: 200.5,
      size: 1000,
      cost: { amount: 2.5, currency: 'USD' },
      stale: false,
    });
    assert.equal(current.prompt, prompt);
    assert.equal(after.entries.length, 2);
  });
}

for (const scenario of [
  'cancelled',
  'failed',
  'foreign',
  'missingReport',
  'oldSummary',
  'noCommit',
] as const) {
  test(`native ${scenario} cannot falsely refresh post-compaction context`, () => {
    const current = usageFixture();
    const previous = structuredClone(current.session.usage);
    const changes = {
      cancelled: () => {
        current.current.status = 'cancelled';
      },
      failed: () => {
        current.current.status = 'failed';
      },
      foreign: () => {
        current.after.sessionId = 'foreign';
      },
      missingReport: () => {
        current.after.contextUsage = undefined;
      },
      oldSummary: () => {
        current.before.entries.push(current.after.entries.at(-1)!);
      },
      noCommit: () => {
        current.after.entries = current.before.entries;
      },
    };
    changes[scenario]();
    applyCompactionUsage(current.session, current.current, current.before, current.after);
    assert.deepEqual(current.session.usage, previous);
  });
}

test('fresh usage reported during compaction immediately replaces the old percentage without becoming stale', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const client = transport.client!;
  await client.handlers.update({
    sessionId: client.sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact' }],
    },
  });
  await client.handlers.update({
    sessionId: client.sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used: 800,
      size: 1000,
    },
  });
  transport.onPrompt = async (blocks) => {
    assert.deepEqual(blocks, [{ type: 'text', text: '/compact' }]);
    await client.handlers.update({
      sessionId: client.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 200,
        size: 1000,
      },
    });
  };
  await host.request({ type: 'compact' });
  assert.deepEqual(host.status()!.context, { used: 200, size: 1000, cost: undefined });
  assert.deepEqual(host.storedState!().sessions.at(-1)!.usage, {
    used: 200,
    size: 1000,
    cost: undefined,
  });
  assert.equal(host.status()!.compacting, false);
});

for (const outcome of ['failure', 'cancel'] as const) {
  test(`compaction ${outcome} preserves pending context, cost and dirty text and releases ownership`, async (context) => {
    const host = await setup(context);
    await host.request({ type: 'connect' });
    const client = transport.client!;
    await client.handlers.update({
      sessionId: client.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compact' }],
      },
    });
    await client.handlers.update({
      sessionId: client.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 123,
        size: 1000,
        cost: { amount: 2.5, currency: 'USD' },
      },
    });
    const target = path.join(host.root, 'dirty.txt');
    seedFile(target, 'disk');
    const document = new Document(Uri.file(target), 'unsaved text');
    fixture.editor = { document, selection: { isEmpty: true } };
    fixture.documents.push(document);
    await host.request({ type: 'attach' });
    const attachments = host.status()!.attachments;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport.onPrompt = async (blocks) => {
      assert.deepEqual(blocks, [{ type: 'text', text: '/compact' }]);
      entered();
      if (outcome === 'cancel')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      throw new Error('fixture compaction failed');
    };
    transport.onCancel = () => release();
    const pending = host.request({ type: 'compact' });
    const settled =
      outcome === 'failure' ? assert.rejects(pending, /fixture compaction failed/) : pending;
    await started;
    if (outcome === 'cancel') {
      assert.equal(host.status()!.compacting, true);
      await host.request({ type: 'cancel' });
    }
    await settled;
    assert.equal(host.status()!.compacting, false);
    assert.equal(host.status()!.busy, false);
    assert.equal(
      host.status()!.turns.at(-1)!.status,
      outcome === 'cancel' ? 'cancelled' : 'failed',
    );
    assert.deepEqual(host.status()!.attachments, attachments);
    assert.deepEqual(host.status()!.context, {
      used: 123,
      size: 1000,
      cost: { amount: 2.5, currency: 'USD' },
      stale: true,
    });
    assert.equal(document.text, 'unsaved text');
    transport.onPrompt = async (blocks) => {
      assert.equal(blocks[1]!.type, 'resource');
    };
    await host.request({ type: 'prompt', text: 'Explicit retry' });
    assert.equal(host.status()!.turns.at(-1)!.status, 'completed');
  });
}

test('compaction persistence failure cannot leave its UI or operation latched', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const client = transport.client!;
  await client.handlers.update({
    sessionId: client.sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact' }],
    },
  });
  await client.handlers.update({
    sessionId: client.sessionId,
    update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
  });
  const save = StateStore.prototype.save;
  const failure = context.mock.method(StateStore.prototype, 'save', function (this: StateStore) {
    if (this.data.sessions.some((session) => session.usage?.stale))
      return Promise.reject(Object.assign(new Error('State storage full'), { code: 'ENOSPC' }));
    return save.call(this);
  });
  await assert.rejects(host.request({ type: 'compact' }), /State storage full/);
  assert.equal(host.status()!.compacting, false);
  assert.equal(host.status()!.busy, false);
  failure.mock.restore();
  await host.request({ type: 'prompt', text: 'Explicit continuation after storage repair' });
  assert.equal(host.status()!.turns.at(-1)!.status, 'completed');
});
