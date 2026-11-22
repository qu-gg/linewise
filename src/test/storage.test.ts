import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStorage, planSessionRemoval } from '../storage.js';
import type { SavedSession, StateStore, Turn } from '../state.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { fixture, Uri } from './vscode-fixture.js';
import { transport } from './acp-fixture.js';

function saved(id: string): SavedSession {
  return { id, label: id, root: 'file:///workspace', turns: [] };
}

function turn(): Turn {
  return { id: 'turn', prompt: 'private prompt', status: 'completed', startedAt: 10, blocks: [] };
}

test('empty storage inventory is exact, non-destructive and never schedules deletion', () => {
  const data = { version: 1 as const, sessions: [], changes: [] };
  const inventory = inspectStorage(data);
  assert.equal(inventory.serializedStateBytes, Buffer.byteLength(JSON.stringify(data)));
  assert.equal(inventory.sessionCount, 0);
  assert.equal(inventory.protectedSessionCount, 0);
  assert.equal(inventory.turnCount, 0);
  assert.equal(inventory.attachmentTextBytes, 0);
  assert.equal(inventory.attachmentImageBytes, 0);
  assert.equal(inventory.reviewTextBytes, 0);
  assert.equal(inventory.retention, 'manual');
  assert.equal(inventory.automaticDeletion, false);
  assert.deepEqual(inventory.missingSessionIds, []);
});

test('image storage accounts decoded pixels once per logical attachment and serialized base64 without exposing either', () => {
  const source = saved('image-owner');
  const attached = {
    id: 'image-id',
    kind: 'image' as const,
    uri: 'file:///image.png',
    label: 'image.png',
    text: 'Image snapshot',
    image: {
      mimeType: 'image/png' as const,
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    },
  };
  source.turns = [{ ...turn(), attachment: attached, attachments: [attached] }];
  const data = { version: 1 as const, sessions: [source], changes: [] };
  const inventory = inspectStorage(data);
  assert.equal(inventory.attachmentCount, 1);
  assert.equal(inventory.attachmentImageBytes, 8);
  assert.equal(inventory.sessions[0]!.attachmentImageBytes, 8);
  assert.equal(inventory.serializedStateBytes, Buffer.byteLength(JSON.stringify(data)));
  assert.equal(inventory.attachmentTextBytes, Buffer.byteLength(attached.text));
  assert.ok(!JSON.stringify(inventory).includes(attached.image.data));
  assert.ok(!JSON.stringify(inventory).includes(attached.text));
});

test('removal planning rejects protected, stale, duplicate and ambiguous session requests atomically', () => {
  const data: StateStore['data'] = {
    version: 1,
    activeSessionId: 'active',
    sessions: [saved('active'), saved('retained')],
    changes: [],
  };
  const original = structuredClone(data);
  assert.deepEqual(planSessionRemoval(data, ['retained']), [data.sessions[1]]);
  for (const ids of [[], ['retained', 'retained'], ['missing'], ['retained', 'active']])
    assert.throws(() => planSessionRemoval(data, ids));
  assert.deepEqual(data, original);
  data.activeSessionId = 'missing';
  assert.throws(() => planSessionRemoval(data, ['retained']), /ambiguous/);
  delete data.activeSessionId;
  data.sessions.push(saved('retained'));
  assert.throws(() => planSessionRemoval(data, ['retained']), /ambiguous/);
});

for (const state of ['applying', 'pending', 'conflict'] as const) {
  test(`inventory protects active/running sessions, ${state} review owners and both recovery branches`, () => {
    const sessions = ['active', 'running', 'review', 'source', 'archive', 'retained'].map(saved);
    sessions[1]!.turns = [{ ...turn(), status: 'running' }];
    sessions[3]!.sessionFile = 'source.jsonl';
    sessions[3]!.historyTransition = {
      archiveId: 'archive',
      entryId: 'entry',
      keepTurns: 0,
      before: { sessionId: 'native-source', leafId: null, fileName: 'source.jsonl', entries: [] },
    };
    const data: StateStore['data'] = {
      version: 1,
      activeSessionId: 'active',
      sessions,
      changes: [
        {
          id: 'change',
          sessionId: 'review',
          path: '/workspace/file',
          before: 'before',
          after: 'after',
          state,
          updatedAt: 10,
        },
      ],
    };
    const original = structuredClone(data);
    const inventory = inspectStorage(data);
    assert.deepEqual(
      inventory.sessions.map((entry) => entry.protectedBy),
      [['active'], ['running'], ['pending-review'], ['history-recovery'], ['recovery-archive'], []],
    );
    assert.equal(inventory.protectedSessionCount, 5);
    assert.deepEqual(inventory.sessions[3]!.nativeFiles, ['source.jsonl']);
    assert.deepEqual(data, original);
    assert.ok(!JSON.stringify(inventory).includes('private prompt'));
  });
}

test('inventory reports dangling protected references rather than treating them as orphans to delete', () => {
  const source = saved('source');
  source.historyTransition = {
    archiveId: 'missing-archive',
    entryId: 'entry',
    keepTurns: 0,
    before: { sessionId: 'native-source', leafId: null, entries: [] },
  };
  const data: StateStore['data'] = {
    version: 1,
    sessions: [source],
    activeSessionId: 'missing-active',
    changes: [
      {
        id: 'change',
        sessionId: 'missing-owner',
        path: '/workspace/file',
        before: null,
        after: '',
        state: 'pending',
        updatedAt: 10,
      },
    ],
  };
  assert.deepEqual(inspectStorage(data).missingSessionIds, [
    'missing-active',
    'missing-owner',
    'missing-archive',
  ]);
});

test('UTF-8 accounting includes all review images but deduplicates legacy attachment aliases', () => {
  const source = saved('source');
  const attached = { uri: 'file:///workspace/file', label: 'file', text: '\u00e9' };
  source.turns = [
    { ...turn(), attachment: attached, attachments: [attached], endedAt: 30 },
    { ...turn(), id: 'legacy', attachment: attached, startedAt: 20 },
  ];
  const data: StateStore['data'] = {
    version: 1,
    sessions: [source],
    changes: [
      {
        id: 'change',
        sessionId: 'source',
        path: '/workspace/file',
        before: '\u00e9',
        after: '\u00e9',
        intermediate: '\u00e9',
        destination: { path: '/workspace/moved', before: null, after: '\u00e9' },
        hunkIntent: { before: '\u00e9', after: '\u00e9', hunkIds: [] },
        state: 'pending',
        updatedAt: 10,
      },
    ],
  };
  const inventory = inspectStorage(data);
  assert.equal(inventory.attachmentCount, 2);
  assert.equal(inventory.attachmentTextBytes, 4);
  assert.equal(inventory.reviewTextBytes, 12);
  assert.equal(inventory.turnCount, 2);
  assert.equal(inventory.sessions[0]!.lastActivityAt, 30);
  assert.equal(inventory.sessions[0]!.serializedBytes, Buffer.byteLength(JSON.stringify(source)));
  assert.equal(inventory.serializedStateBytes, Buffer.byteLength(JSON.stringify(data)));
});

test('inspection opens fresh virtual snapshots without OMP or changing committed state', async (context) => {
  const host = await setup(context);
  const inspect = fixture.commands.get('omp.inspectStorage')!;
  await inspect();
  const first = fixture.documents.at(-1)!;
  assert.equal(first.uri.scheme, 'omp-storage');
  assert.equal(JSON.parse(first.getText()).sessionCount, 0);
  assert.equal(transport.client, undefined);
  await host.request({ type: 'connect' });
  await host.request({ type: 'prompt', text: 'Stored private content' });
  const stateFile = path.join(host.storage, 'state.json');
  const committed = await readFile(stateFile, 'utf8');
  const original = host.storedState!();
  let sent = 0;
  transport.onPrompt = async () => {
    sent++;
  };
  await inspect();
  const latest = fixture.documents.at(-1)!;
  assert.notEqual(latest.uri.toString(), first.uri.toString());
  assert.equal(JSON.parse(first.getText()).sessionCount, 0);
  const report = JSON.parse(latest.getText());
  assert.equal(report.storageDirectory, host.storage);
  assert.equal(report.scope, 'current-host-state');
  assert.equal(report.nativeArtifactSizes, 'regular-jsonl-only');
  assert.equal(report.sessionCount, 1);
  assert.equal(report.turnCount, 1);
  assert.deepEqual(report.sessions[0].protectedBy, ['active']);
  assert.equal(sent, 0);
  assert.deepEqual(host.storedState!(), original);
  assert.equal(await readFile(stateFile, 'utf8'), committed);
});

test('protection reasons accumulate without double-counting a session', () => {
  const source = saved('source');
  source.turns = [{ ...turn(), status: 'running' }];
  source.historyTransition = {
    archiveId: 'archive',
    entryId: 'entry',
    keepTurns: 0,
    before: { sessionId: 'native-source', leafId: null, entries: [] },
  };
  const data: StateStore['data'] = {
    version: 1,
    activeSessionId: 'source',
    sessions: [source, saved('archive')],
    changes: [
      {
        id: 'change',
        sessionId: 'source',
        path: '/workspace/file',
        before: 'before',
        after: 'after',
        state: 'pending',
        updatedAt: 10,
      },
    ],
  };
  const inventory = inspectStorage(data);
  assert.equal(inventory.protectedSessionCount, 2);
  assert.deepEqual(inventory.sessions[0]!.protectedBy, [
    'active',
    'pending-review',
    'running',
    'history-recovery',
  ]);
});

test('storage fallback and a replacement host cannot reuse a stale inventory document', async (context) => {
  const host = await setup(context);
  await fixture.commands.get('omp.inspectStorage')!();
  const original = fixture.documents.at(-1)!;
  const { initializeStorage } = await import('../storage-view.js');
  const global = path.join(host.storage, 'global-only');
  const store = await initializeStorage({
    ...host.extensionContext,
    storageUri: undefined,
    globalStorageUri: Uri.file(global),
  } as unknown as import('vscode').ExtensionContext);
  assert.equal(store.directory, global);
  store.data.sessions.push(saved('replacement-host'));
  await fixture.commands.get('omp.inspectStorage')!();
  const replacement = fixture.documents.at(-1)!;
  assert.notEqual(replacement.uri.toString(), original.uri.toString());
  assert.equal(JSON.parse(replacement.getText()).sessions[0].id, 'replacement-host');
  assert.equal(JSON.parse(original.getText()).sessionCount, 0);
});

test('inspection retains protected session metadata after missing native history refuses resume', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await host.request({ type: 'prompt', text: 'Retained transcript without native artifact' });
  const original = host.storedState!();
  const stateFile = path.join(host.storage, 'state.json');
  const committed = await readFile(stateFile, 'utf8');
  await fixture.commands.get('omp.sessions')!();
  await assert.rejects(
    host.request({ type: 'resumeSession', id: original.activeSessionId }),
    /native session file is unavailable/,
  );
  assert.equal(host.status()!.connected, false);
  await fixture.commands.get('omp.inspectStorage')!();
  const report = JSON.parse(fixture.documents.at(-1)!.getText());
  assert.equal(report.sessionCount, 1);
  assert.equal(report.turnCount, 1);
  assert.deepEqual(report.sessions[0].protectedBy, ['active']);
  assert.deepEqual(host.storedState!(), original);
  assert.equal(await readFile(stateFile, 'utf8'), committed);
});
