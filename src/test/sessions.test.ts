import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore, cloneSession } from '../state.js';
import { editSession, inspectSession, reconcileActiveSession, sessionList } from '../sessions.js';
import { planSessionRemoval, inspectStorage } from '../storage.js';
import { setup } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';
import {
  instructionArguments,
  workspaceInstructions,
  withInstructionSnapshot,
} from '../workspace-instructions.js';

test('workspace instructions use bounded canonical sources and private immutable startup captures', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-instructions-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'root');
  await mkdir(root);
  const read = (target: string) => readFile(target, 'utf8');
  assert.equal(await workspaceInstructions(root, read), '');
  assert.deepEqual(instructionArguments(), ['--no-context-files', '--no-rules', '--no-skills']);
  await writeFile(path.join(root, 'AGENTS.md'), 'ROOT @../outside.md');
  const initial = await workspaceInstructions(root, read);
  await mkdir(path.join(root, '.github'));
  await writeFile(path.join(root, '.github/copilot-instructions.md'), 'COPILOT');
  assert.match(await workspaceInstructions(root, read), /COPILOT/);
  await mkdir(path.join(root, '.omp'));
  const native = path.join(root, '.omp/AGENTS.md');
  await writeFile(native, 'NATIVE');
  assert.match(await workspaceInstructions(root, read), /NATIVE/);
  assert.equal(await workspaceInstructions(root, async () => null), '');
  let capture = '';
  await withInstructionSnapshot(directory, initial, async (file) => {
    capture = file;
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(instructionArguments(file), [
      '--no-context-files',
      '--no-rules',
      '--no-skills',
      '--append-system-prompt',
      file,
    ]);
    await writeFile(path.join(root, 'AGENTS.md'), 'CHANGED');
    assert.equal(await readFile(file, 'utf8'), initial);
  });
  await assert.rejects(stat(capture), { code: 'ENOENT' });
  await assert.rejects(
    withInstructionSnapshot(directory, '', async (file) => {
      capture = file;
      throw new Error('startup refused');
    }),
    /startup refused/,
  );
  await assert.rejects(stat(capture), { code: 'ENOENT' });
  await writeFile(native, 'x'.repeat(65537));
  await assert.rejects(workspaceInstructions(root, read), /64 KiB/);
  await writeFile(native, 'NATIVE');
  await assert.rejects(
    workspaceInstructions(root, async () => 'x'.repeat(65537)),
    /64 KiB/,
  );
  await rm(native);
  await mkdir(native);
  await assert.rejects(workspaceInstructions(root, read), /regular/);
  await rm(native, { recursive: true });
  const outside = path.join(directory, 'outside.md');
  await writeFile(outside, 'OUTSIDE');
  await symlink(outside, native);
  await assert.rejects(workspaceInstructions(root, read), /outside/);
  await rm(native);
  await symlink(path.join(directory, 'missing.md'), native);
  assert.match(await workspaceInstructions(root, read), /COPILOT/);
  await assert.rejects(
    workspaceInstructions(root, async () => {
      throw new Error('read refused');
    }),
    /read refused/,
  );
});

test('legacy sessions gain reversible archive and title metadata without changing conversation or native identity', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-session-metadata-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = {
    id: 'original',
    label: 'Original label',
    root: 'file:///workspace',
    sessionFile: 'original.jsonl',
    turns: [],
  };
  await writeFile(
    path.join(directory, 'state.json'),
    JSON.stringify({ version: 1, sessions: [original], changes: [] }),
  );
  const store = new StateStore(directory);
  await store.load();
  assert.equal(sessionList(store.data)[0]!.archived, false);
  await editSession(store, 'original', 'renameSession', '  Renamed session  ');
  await inspectSession(store, 'original');
  assert.equal(store.data.activeSessionId, 'original');
  await editSession(store, 'original', 'archiveSession');
  assert.equal(store.data.activeSessionId, undefined);
  const reopened = new StateStore(directory);
  await reopened.load();
  assert.equal(reopened.data.sessions[0]!.title, 'Renamed session');
  assert.equal(sessionList(reopened.data)[0]!.archived, true);
  assert.throws(() => planSessionRemoval(reopened.data, ['original']), /protected/);
  assert.deepEqual(inspectStorage(reopened.data).sessions[0]!.protectedBy, ['user-archive']);
  await editSession(reopened, 'original', 'restoreSession');
  assert.deepEqual(
    { ...reopened.data.sessions[0], title: undefined, archivedAt: undefined },
    { ...original, title: undefined, archivedAt: undefined },
  );
  const cloned = cloneSession(
    { ...original, title: 'Source title', archivedAt: 1 },
    'copy',
    { sessionId: 'native', fileName: 'copy.jsonl', entries: [], leafId: null },
    0,
    'Recovery copy',
  );
  assert.equal(cloned.title, undefined);
  assert.equal(cloned.archivedAt, undefined);
  assert.equal(cloned.label, 'Recovery copy');
});

test('session manager archives idle owners, inspects without generation and requires explicit restore/resume', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const id = host.status()!.sessionId!;
  await host.request({ type: 'renameSession', id, title: 'Custom title' });
  assert.equal(host.status()!.session, 'Custom title');
  let generations = 0;
  transport.onPrompt = async () => {
    generations++;
  };
  await host.request({ type: 'archiveSession', id });
  assert.equal(host.status()!.connected, false);
  assert.equal(host.status()!.sessionId, undefined);
  assert.equal(host.status()!.sessions[0]!.archived, true);
  await assert.rejects(host.request({ type: 'resumeSession', id }), /Restore/);
  await host.request({ type: 'openSession', id });
  assert.equal(host.status()!.sessionId, id);
  assert.equal(host.status()!.connected, false);
  assert.equal(generations, 0);
  await assert.rejects(host.request({ type: 'connect' }), /Restore/);
  assert.equal(host.status()!.sessionId, id);
  assert.equal(host.status()!.connected, false);
  await host.request({ type: 'restoreSession', id });
  await host.request({ type: 'resumeSession', id });
  assert.equal(host.status()!.connected, true);
  assert.equal(generations, 0);
  await assert.rejects(host.request({ type: 'openSession', id: 'foreign' }), /no longer exists/);
});

test('fresh connects reuse an existing identity, replace an idle empty chat, and keep one record per chat', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const first = host.status()!.sessionId!;
  assert.equal(host.storedState!().sessions.length, 1);
  assert.equal(host.status()!.session, 'New Session');

  await host.request({ type: 'new' });
  assert.equal(host.storedState!().sessions.length, 1);
  assert.equal(host.status()!.sessionId, first);

  const second = 'second-native';
  transport.nextSessionId = second;
  await host.request({ type: 'new' });
  assert.equal(host.storedState!().sessions.length, 1);
  assert.equal(host.status()!.sessionId, second);

  await host.request({ type: 'prompt', text: 'First prompt' });
  assert.equal(host.status()!.turns.length, 1);
  transport.nextSessionId = 'third-native';
  await host.request({ type: 'new' });
  assert.equal(host.storedState!().sessions.length, 2);
  assert.equal(host.status()!.sessionId, 'third-native');
  assert.equal(
    host.storedState!().sessions.find((session) => session.id === 'second-native')!.turns.length,
    1,
  );
});

test('a failed first connect restores staged attachments instead of clearing them', async (context) => {
  const host = await setup(context);
  await host.attachSnapshots!([
    {
      kind: 'file',
      label: 'staged.txt',
      uri: 'file:///workspace/staged.txt',
      text: 'Staged context',
    },
  ]);
  assert.equal(host.status()!.attachments.length, 1);
  const save = StateStore.prototype.save;
  context.after(() => {
    StateStore.prototype.save = save;
  });
  StateStore.prototype.save = async () => {
    throw new Error('state save failed');
  };
  await assert.rejects(host.request({ type: 'connect' }), /state save failed/);
  StateStore.prototype.save = save;
  assert.equal(host.storedState!().sessions.length, 0);
  assert.equal(host.status()!.attachments.length, 1);
  assert.equal(host.status()!.attachments[0]!.label, 'staged.txt');
});

test('a new chat retains an idle empty chat that still owns attached context', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const original = host.status()!.sessionId!;
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
  await host.request({ type: 'pasteImages', images: [{ mimeType: 'image/png', data }] });
  assert.equal(host.status()!.attachments.length, 1);

  transport.nextSessionId = 'context-native';
  await host.request({ type: 'new' });

  assert.equal(host.status()!.sessionId, 'context-native');
  assert.deepEqual(host.status()!.attachments, []);
  assert.equal(host.storedState!().sessions.length, 2);
  const retained = host.status()!.sessions.find((session) => session.id === original)!;
  assert.equal(retained.empty, true);
  assert.equal(retained.active, false);
  assert.equal(retained.attachments, 1);
  assert.equal(
    host.storedState!().sessions.find((session) => session.id === original)!.turns.length,
    0,
  );
});

test('a fresh connection refuses a non-empty native identity collision', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await host.request({ type: 'prompt', text: 'Existing prompt' });
  const before = host.storedState!();
  await assert.rejects(host.request({ type: 'new' }), /existing session identity/);
  assert.equal(host.storedState!().sessions.length, 1);
  assert.equal(host.status()!.sessionId, before.activeSessionId);
  assert.equal(host.status()!.turns.length, 1);
  assert.equal(host.status()!.turns[0]!.prompt, 'Existing prompt');
});

test('a failed connection removes only the empty session it created', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const original = host.storedState!().sessions.map((session) => session.id);
  transport.nextSessionId = 'failing-native';
  const start = OmpClient.prototype.start;
  const history = OmpClient.prototype.history;
  context.after(() => {
    OmpClient.prototype.start = start;
    OmpClient.prototype.history = history;
  });
  OmpClient.prototype.start = async function (options) {
    await start.call(this, options);
    this.historyAvailable = true;
  };
  OmpClient.prototype.history = async () => {
    throw new Error('history fixture failure');
  };
  await assert.rejects(host.request({ type: 'new' }), /history fixture failure/);
  assert.deepEqual(
    host.storedState!().sessions.map((session) => session.id),
    original,
  );
  assert.equal(host.status()!.sessionId, original[0]);
  assert.equal(host.status()!.connected, false);
});

test('active-session reconciliation clears a stale id without dropping records', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-stale-session-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = [
    { id: 'kept', root: 'file:///workspace', label: 'Kept', turns: [] },
    { id: 'also-kept', root: 'file:///workspace', label: 'Also kept', turns: [] },
  ];
  await writeFile(
    path.join(directory, 'state.json'),
    JSON.stringify({ version: 1, sessions, changes: [], activeSessionId: 'missing' }),
  );
  const store = new StateStore(directory);
  await store.load();
  reconcileActiveSession(store.data);
  assert.equal(store.data.activeSessionId, undefined);
  assert.deepEqual(store.data.sessions, sessions);
});

test('session list labels empty chats honestly and marks them for picker filtering', () => {
  const data: StateStore['data'] = {
    version: 1,
    activeSessionId: 'active',
    sessions: [
      { id: 'active', root: 'file:///workspace', label: 'workspace', turns: [] },
      { id: 'abandoned', root: 'file:///workspace', label: 'workspace', turns: [] },
      {
        id: 'named',
        root: 'file:///workspace',
        label: 'workspace',
        title: 'Prepared chat',
        turns: [],
      },
      {
        id: 'used',
        root: 'file:///workspace',
        label: 'Used chat',
        turns: [{ id: 'turn', prompt: 'Prompt', status: 'completed', startedAt: 10, blocks: [] }],
      },
    ],
    changes: [],
  };
  const listed = sessionList(data);
  assert.deepEqual(listed.map((session) => session.id).sort(), [
    'abandoned',
    'active',
    'named',
    'used',
  ]);
  assert.equal(listed.find((session) => session.id === 'active')!.title, 'New Session');
  assert.equal(listed.find((session) => session.id === 'abandoned')!.empty, true);
  assert.equal(listed.find((session) => session.id === 'abandoned')!.attachments, 0);
  assert.equal(
    sessionList(data, (id) => (id === 'abandoned' ? 2 : 0)).find(
      (session) => session.id === 'abandoned',
    )!.attachments,
    2,
  );
  assert.equal(listed.find((session) => session.id === 'used')!.title, 'Used chat');
});

test('session metadata writes validate titles and owner IDs and roll back on persistence failure', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-session-metadata-failure-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory, 1);
  store.data.sessions = [
    { id: 'original', label: 'Original', root: 'file:///workspace', turns: [] },
  ];
  const previous = store.data.sessions;
  store.data.activeSessionId = 'original';
  await assert.rejects(editSession(store, 'missing', 'archiveSession'), /no longer exists/);
  for (const title of ['', 'x'.repeat(201), 'line\nbreak'])
    await assert.rejects(editSession(store, 'original', 'renameSession', title));
  await assert.rejects(editSession(store, 'original', 'archiveSession'), /storage budget/);
  assert.equal(store.data.sessions, previous);
  assert.equal(store.data.activeSessionId, 'original');
  await assert.rejects(inspectSession(store, 'missing'), /no longer exists/);
  store.data.activeSessionId = undefined;
  await assert.rejects(inspectSession(store, 'original'), /storage budget/);
  assert.equal(store.data.activeSessionId, undefined);
  assert.equal(sessionList(store.data)[0]!.archived, false);
  store.data.sessions[0]!.turns.push({
    id: 'turn',
    prompt: 'Running',
    status: 'running',
    startedAt: 1,
    blocks: [],
  });
  await assert.rejects(editSession(store, 'original', 'archiveSession'), /operation to finish/);
});

test('session list reports last activity and pending-review line totals', () => {
  const data: StateStore['data'] = {
    version: 1,
    sessions: [
      {
        id: 'saved',
        root: 'file:///workspace',
        label: 'Saved',
        turns: [
          {
            id: 'turn',
            prompt: 'Prompt',
            status: 'completed',
            startedAt: 10,
            endedAt: 20,
            blocks: [],
          },
        ],
      },
    ],
    changes: [
      {
        id: 'change',
        sessionId: 'saved',
        path: '/workspace/file.ts',
        before: 'old\n',
        after: 'new\nlines\n',
        state: 'pending',
        updatedAt: 1,
      },
    ],
  };
  const listed = sessionList(data)[0]!;
  assert.equal(listed.lastActivityAt, 20);
  assert.equal(listed.pendingReview, true);
  assert.equal(listed.added, 2);
  assert.equal(listed.removed, 1);
});
