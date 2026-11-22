import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendChunk,
  bindTurnHistory,
  cloneSession,
  parseUsage,
  reconcileHistory,
  StateStore,
  webviewMessage,
} from '../state.js';
import type { SavedSession, Turn } from '../state.js';
import type { HistorySnapshot } from '../history.js';
import { reviewImages, reviewSummary } from '../review-presentation.js';

test('context usage accepts reported totals without inventing costs and rejects invalid windows', () => {
  assert.deepEqual(parseUsage({ used: 94700, size: 400000, cost: null }), {
    used: 94700,
    size: 400000,
    cost: undefined,
  });
  assert.equal(parseUsage({ used: -1, size: 400000 }), undefined);
  assert.equal(parseUsage({ used: 1, size: 0 }), undefined);
  assert.equal(parseUsage({ used: Infinity, size: 100 }), undefined);
  assert.deepEqual(
    parseUsage({ used: 100, size: 1000, cost: { amount: 0.02, currency: 'USD' } })?.cost,
    { amount: 0.02, currency: 'USD' },
  );
  for (const type of ['compact', 'inspectContext', 'keepAll', 'discardAll'])
    assert.ok(webviewMessage.safeParse({ v: 1, type }).success);
});

test('streamed chunks merge without IDs and stay separate across thinking and tool boundaries', () => {
  const current: Turn = {
    id: 'turn',
    prompt: 'test',
    startedAt: Date.now(),
    status: 'running',
    blocks: [],
  };
  appendChunk(current, 'text', 'First ');
  appendChunk(current, 'text', 'progress.');
  appendChunk(current, 'thought', 'Consider ');
  appendChunk(current, 'thought', 'the file.');
  current.blocks.push({ id: 'write', kind: 'tool', text: '' });
  appendChunk(current, 'text', 'Final ');
  appendChunk(current, 'text', 'answer.');
  assert.deepEqual(
    current.blocks.map((block) => block.text),
    ['First progress.', 'Consider the file.', '', 'Final answer.'],
  );
  appendChunk(current, 'text', 'Named', 'message');
  appendChunk(current, 'text', ' message.', 'message');
  assert.equal(current.blocks.at(-1)?.text, 'Named message.');
});

test('sidebar messages reject unrecognized actions and untrusted review paths', () => {
  assert.ok(webviewMessage.safeParse({ v: 1, type: 'prompt', text: 'hello' }).success);
  assert.equal(webviewMessage.safeParse({ v: 2, type: 'prompt', text: 'hello' }).success, false);
  assert.equal(
    webviewMessage.safeParse({ v: 1, type: 'write', path: '/private', content: 'no' }).success,
    false,
  );
  assert.equal(
    webviewMessage.safeParse({ v: 1, type: 'discard', path: '/private' }).success,
    false,
  );
  assert.equal(
    webviewMessage.safeParse({ v: 1, type: 'config', id: 'approvalMode', value: 'yolo' }).success,
    false,
  );
});

test('model blocks retain their original timestamp and model across streamed chunks', () => {
  const current: Turn = {
    id: 'turn',
    prompt: 'test',
    startedAt: 100,
    status: 'running',
    blocks: [],
  };
  appendChunk(current, 'text', 'First ', 'first', { receivedAt: 123, model: 'provider/model-one' });
  appendChunk(current, 'text', 'answer.', 'first', {
    receivedAt: 456,
    model: 'provider/model-two',
  });
  assert.deepEqual(current.blocks[0], {
    id: 'text:first',
    kind: 'text',
    text: 'First answer.',
    receivedAt: 123,
    model: 'provider/model-one',
  });
  appendChunk(current, 'text', 'Next answer.', 'second', {
    receivedAt: 789,
    model: 'provider/model-two',
  });
  assert.equal(current.blocks[1]?.model, 'provider/model-two');
});

test('canonical boundaries distinguish identical prompts and forks preserve attachments without mutating the source', () => {
  const before: HistorySnapshot = {
    sessionId: 'native',
    leafId: 'first',
    entries: [{ id: 'first', parentId: null, type: 'message', role: 'user' }],
  };
  const after: HistorySnapshot = {
    sessionId: 'native',
    leafId: 'second',
    entries: [
      ...before.entries,
      { id: 'second', parentId: 'first', type: 'message', role: 'user' },
    ],
  };
  const current: Turn = {
    id: 'local',
    prompt: 'same prompt',
    startedAt: 1,
    status: 'completed',
    blocks: [],
    attachment: { label: 'dirty.txt', uri: 'file:///dirty.txt', text: 'unsaved text' },
  };
  bindTurnHistory(current, before, after);
  assert.equal(current.history?.promptEntryId, 'second');
  const source: SavedSession = {
    id: 'original',
    root: 'file:///workspace',
    label: 'Source',
    turns: [current],
  };
  const original = structuredClone(source);
  const fork = cloneSession(source, 'fork', { ...after, sessionId: 'fork-native' }, 1, 'Fork');
  assert.equal(fork.turns[0]?.history?.sessionId, 'fork-native');
  assert.deepEqual(fork.turns[0]?.attachment, current.attachment);
  assert.deepEqual(source, original);
  assert.ok(
    webviewMessage.safeParse({ v: 1, type: 'editPrompt', id: 'local', text: 'changed' }).success,
  );
  assert.equal(
    webviewMessage.safeParse({
      v: 1,
      type: 'forkTurn',
      id: 'local',
      boundary: 'arbitrary',
      entryId: 'spoof',
    }).success,
    false,
  );
});

test('interrupted history transitions reconcile only a proven prefix and preserve the original on ambiguity', () => {
  const before: HistorySnapshot = {
    sessionId: 'native',
    leafId: 'future',
    entries: [
      { id: 'past', parentId: null, type: 'message', role: 'user' },
      { id: 'future', parentId: 'past', type: 'message', role: 'user' },
    ],
  };
  const source: SavedSession = {
    id: 'original',
    root: 'file:///workspace',
    label: 'Source',
    turns: [
      { id: 'one', prompt: 'same', startedAt: 1, status: 'completed', blocks: [] },
      { id: 'two', prompt: 'same', startedAt: 2, status: 'completed', blocks: [] },
    ],
    historyTransition: { before, entryId: 'future', keepTurns: 1, archiveId: 'archive' },
  };
  const unchanged = structuredClone(source);
  assert.equal(reconcileHistory(unchanged, before), 'unchanged');
  assert.equal(unchanged.turns.length, 2);
  const ambiguous = structuredClone(source);
  assert.throws(
    () => reconcileHistory(ambiguous, { ...before, entries: [before.entries[1]!] }),
    /ambiguous/,
  );
  assert.deepEqual(ambiguous, source);
  assert.throws(
    () =>
      reconcileHistory(ambiguous, {
        ...before,
        leafId: 'summary',
        entries: [before.entries[0]!, { id: 'summary', parentId: 'past', type: 'branch_summary' }],
      }),
    /ambiguous/,
  );
  assert.deepEqual(ambiguous, source);
  assert.equal(
    reconcileHistory(source, { ...before, leafId: 'past', entries: [before.entries[0]!] }),
    'rewound',
  );
  assert.equal(source.turns.length, 1);
  assert.equal(source.historyTransition, undefined);
});

test('history recovery accepts only unchanged prefixes with linked bookkeeping, never injected conversation', () => {
  const before: HistorySnapshot = {
    sessionId: 'native',
    leafId: 'future',
    entries: [
      { id: 'past', parentId: null, type: 'message', role: 'user' },
      { id: 'future', parentId: 'past', type: 'message', role: 'user' },
    ],
  };
  const base: SavedSession = {
    id: 'source',
    root: 'file:///workspace',
    label: 'Source',
    turns: ['past', 'future'].map((id) => ({
      id,
      prompt: id,
      startedAt: 0,
      status: 'completed',
      blocks: [],
    })),
    historyTransition: { before, entryId: 'future', keepTurns: 1, archiveId: 'archive' },
  };
  for (const length of [1, 2]) {
    for (const type of ['model_change', 'thinking_level_change', 'custom']) {
      const session = structuredClone(base);
      const entries = before.entries.slice(0, length);
      entries.push({ id: 'bookkeeping', parentId: entries.at(-1)!.id, type });
      assert.equal(
        reconcileHistory(session, { ...before, leafId: 'bookkeeping', entries }),
        length === 1 ? 'rewound' : 'unchanged',
      );
      assert.equal(session.turns.length, length);
    }
  }
  for (const injected of [
    { id: 'injected', parentId: 'future', type: 'message', role: 'user' },
    { id: 'injected', parentId: 'future', type: 'branch_summary' },
    { id: 'injected', parentId: 'future', type: 'compaction' },
    { id: 'injected', parentId: 'wrong', type: 'model_change' },
    { id: 'injected', parentId: 'future', type: 'custom', role: 'assistant' },
  ]) {
    const session = structuredClone(base);
    assert.throws(
      () => reconcileHistory(session, { ...before, entries: [...before.entries, injected] }),
      /ambiguous/,
    );
    assert.deepEqual(session, base);
  }
  const altered = structuredClone(before);
  altered.entries[0]!.type = 'branch_summary';
  assert.throws(() => reconcileHistory(structuredClone(base), altered), /ambiguous/);
});

test('image attachment bytes survive private state reload and malformed image payloads fail without overwrite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-image-state-'));
  try {
    const store = new StateStore(directory);
    await store.load();
    const image = {
      mimeType: 'image/png' as const,
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    };
    const attachment = {
      id: 'image',
      kind: 'image' as const,
      uri: 'file:///no-longer-present.png',
      label: 'Original snapshot',
      text: 'Untrusted image',
      image,
    };
    store.data.sessions.push({
      id: 'image-owner',
      root: 'file:///workspace',
      label: 'Images',
      turns: [
        {
          id: 'turn',
          prompt: 'Inspect snapshot',
          startedAt: 100,
          status: 'completed',
          blocks: [],
          attachment,
          attachments: [attachment],
        },
      ],
    });
    await store.save();
    const restored = new StateStore(directory);
    await restored.load();
    assert.deepEqual(restored.data.sessions, store.data.sessions);
    const data = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    data.sessions[0].turns[0].attachments[0].image.data = 'invalid base64';
    const corrupted = JSON.stringify(data);
    await writeFile(path.join(directory, 'state.json'), corrupted);
    await assert.rejects(new StateStore(directory).load(), /not been overwritten/);
    assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), corrupted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending snapshots survive reload with private permissions and corrupt state is not overwritten', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-state-'));
  try {
    const store = new StateStore(directory);
    await store.load();
    store.data.sessions.push({
      id: 'session',
      root: 'file:///workspace',
      label: 'Test',
      turns: [{ id: 'turn', prompt: 'test', startedAt: 100, status: 'completed', blocks: [] }],
    });
    appendChunk(store.data.sessions[0]!.turns[0]!, 'text', 'Saved response', 'answer', {
      receivedAt: 123,
      model: 'provider/model',
    });
    store.data.changes.push({
      id: 'change',
      sessionId: 'session',
      path: '/file.txt',
      before: 'user work',
      after: 'agent work',
      state: 'pending',
      updatedAt: Date.now(),
    });
    await store.save();
    assert.equal((await stat(path.join(directory, 'state.json'))).mode & 0o777, 0o600);
    const restored = new StateStore(directory);
    await restored.load();
    assert.deepEqual(restored.data.changes, store.data.changes);
    assert.deepEqual(restored.data.sessions, store.data.sessions);
    const change = store.data.changes[0]!;
    change.destination = { path: '/renamed.txt', before: null, after: 'agent work' };
    change.intermediate = 'partial';
    change.resolving = true;
    change.incomplete = true;
    change.after = null;
    await store.save();
    await restored.load();
    assert.deepEqual(restored.data.changes, store.data.changes);
    assert.equal(reviewSummary(change, path.basename).name, 'file.txt -> renamed.txt');
    assert.equal(reviewSummary(change, path.basename).added, 1);
    assert.deepEqual(
      reviewImages(change).map((image) => image.text),
      ['user work', 'agent work'],
    );
    assert.match(reviewImages(change)[1]!.path, /renamed.txt$/);
    delete change.destination;
    assert.equal(reviewSummary(change, path.basename).name, 'file.txt (Deleted)');
    assert.equal(reviewSummary(change, path.basename).removed, 1);
    assert.equal(reviewImages(change)[1]!.text, '');
    assert.equal(reviewImages({ ...change, before: null, after: 'created' })[0]!.text, '');
    assert.equal(
      reviewSummary({ ...change, before: null, after: '' }, path.basename).name,
      'file.txt',
    );
    await writeFile(path.join(directory, 'state.json'), '{broken');
    await assert.rejects(new StateStore(directory).load(), /not been overwritten/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
