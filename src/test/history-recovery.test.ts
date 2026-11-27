import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ExtensionContext } from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';
import { Document, fixture, seedFile, Uri, view } from './vscode-fixture.js';
import { StateStore } from '../state.js';
import type { HistoryOperation, HistorySnapshot } from '../history.js';

const { activate, deactivate } = await import('../extension.js');
const stages = [
  'archive',
  'intent',
  'navigation-before',
  'navigation-after',
  'verification',
  'rewind-save',
  'replacement',
  'final-save',
  'fork-save',
] as const;
type Stage = (typeof stages)[number];

function installNativeHistory(
  context: TestContext,
  source: HistorySnapshot,
  stage: Stage,
  fault: { armed: boolean; crashed: boolean },
  fail: () => never,
) {
  const branches = new Map([['native-session', source]]);
  const start = OmpClient.prototype.start;
  context.mock.method(
    OmpClient.prototype,
    'start',
    async function (this: OmpClient, options: Parameters<OmpClient['start']>[0]) {
      await start.call(this, options);
      this.historyAvailable = true;
    },
  );
  context.mock.method(OmpClient.prototype, 'fork', async () => {
    if (fault.armed && stage === 'archive') fail();
    branches.set('archive', {
      ...structuredClone(source),
      sessionId: 'archive',
      fileName: 'archive.jsonl',
    });
    return { sessionId: 'archive' };
  });
  context.mock.method(
    OmpClient.prototype,
    'history',
    async function (
      this: OmpClient,
      operation: HistoryOperation = { action: 'inspect' },
      handle = this.sessionId,
    ) {
      const branch = branches.get(handle)!;
      if (operation.action === 'navigate') {
        if (stage === 'navigation-before') fail();
        const target = branch.entries.findIndex((entry) => entry.id === operation.entryId);
        branch.entries.splice(target);
        branch.leafId = branch.entries.at(-1)?.id ?? null;
        if (stage === 'navigation-after') fail();
        if (stage === 'verification') {
          fault.crashed = true;
          branch.entries.push({
            id: 'injected-summary',
            parentId: branch.leafId,
            type: 'branch_summary',
          });
          branch.leafId = 'injected-summary';
        }
      }
      return structuredClone(branch);
    },
  );
}

function failsSave(stage: Stage, store: StateStore): boolean {
  const current = store.data.sessions.find((session) => session.id === 'native-session')!;
  const checks: Partial<Record<Stage, () => boolean>> = {
    intent: () => Boolean(current.historyTransition),
    'rewind-save': () => current.turns.length === 1 && !current.historyTransition,
    'final-save': () => {
      const final = current.turns.at(-1)!;
      return final.prompt === 'replacement' && final.status === 'completed';
    },
    'fork-save': () => store.data.activeSessionId === 'archive',
  };
  return checks[stage]?.() ?? false;
}

async function recoveryFixture(context: TestContext, stage: Stage) {
  const host = await setup(context);
  const source: HistorySnapshot = {
    sessionId: 'native-session',
    fileName: 'source.jsonl',
    leafId: null,
    entries: [],
  };
  const fault = { armed: false, crashed: false };
  const sent: string[] = [];
  const fail = () => {
    fault.crashed = true;
    throw new Error(`injected ${stage}`);
  };
  installNativeHistory(context, source, stage, fault, fail);
  const save = StateStore.prototype.save;
  context.mock.method(StateStore.prototype, 'save', function (this: StateStore) {
    if (fault.crashed) return Promise.resolve();
    if (fault.armed && failsSave(stage, this)) fail();
    return save.call(this);
  });
  transport.onPrompt = async (blocks) => {
    const text = blocks[0]?.type === 'text' ? blocks[0].text : '';
    sent.push(text);
    const id = `entry-${source.entries.length}`;
    source.entries.push({ id, parentId: source.leafId, type: 'message', role: 'user' });
    source.leafId = id;
    if (fault.armed && stage === 'replacement') fail();
    const answer = `${id}-answer`;
    source.entries.push({ id: answer, parentId: id, type: 'message', role: 'assistant' });
    source.leafId = answer;
  };
  await host.request({ type: 'connect' });
  const target = path.join(host.root, 'dirty.txt');
  seedFile(target, 'disk baseline');
  const document = new Document(Uri.file(target), 'unsaved baseline');
  fixture.documents.push(document);
  await host.request({ type: 'prompt', text: 'past' });
  const onPrompt = transport.onPrompt;
  transport.onPrompt = async (blocks) => {
    await onPrompt(blocks);
    await transport.client!.handlers.write({
      sessionId: 'native-session',
      path: target,
      content: 'pending review',
    });
  };
  await host.request({ type: 'prompt', text: 'future' });
  transport.onPrompt = onPrompt;
  document.isDirty = true;
  return { host, fault, sent, source, document, target };
}

test('successful fork returns the selected prompt as a draft without generation or file/review changes', async (context) => {
  const { host, sent, document, target } = await recoveryFixture(context, 'archive');
  await host.request({ type: 'permissions', mode: 'yolo', confirmed: true });
  const before = host.storedState!();
  const original = before.sessions.find((session) => session.id === before.activeSessionId)!;
  const disk = structuredClone(fixture.disk.get(target));
  const dirty = document.text;
  const posted = context.mock.method(view.webview, 'postMessage');
  const selected = host.status()!.turns[1]!;
  await host.request({ type: 'forkTurn', id: selected.id, boundary: 'before' });
  const saved = host.storedState!();
  assert.notEqual(saved.activeSessionId, original.id);
  assert.deepEqual(
    saved.sessions.find((session) => session.id === original.id)!.turns,
    original.turns,
  );
  assert.deepEqual(
    host.status()!.turns.map((turn) => turn.prompt),
    ['past'],
  );
  assert.equal(host.status()!.permissions, 'rules');
  assert.deepEqual(sent, ['past', 'future']);
  assert.deepEqual(saved.changes, before.changes);
  assert.deepEqual(fixture.disk.get(target), disk);
  assert.equal(document.text, dirty);
  assert.equal(document.isDirty, true);
  assert.ok(
    posted.mock.calls.some(
      (call) =>
        JSON.stringify(call.arguments[0]) ===
        JSON.stringify({ v: 1, type: 'draft', text: 'future' }),
    ),
  );
});

test('editing a prompt preserves a selected Ask permission mode', async (context) => {
  const { host } = await recoveryFixture(context, 'archive');
  await host.request({ type: 'permissions', mode: 'ask' });
  assert.equal(host.status()!.permissions, 'ask');
  const selected = host.status()!.turns[1]!;
  await host.request({ type: 'editPrompt', id: selected.id, text: 'replacement' });
  assert.equal(host.status()!.permissions, 'ask');
});

test('forking a prompt preserves a selected Ask permission mode', async (context) => {
  const { host } = await recoveryFixture(context, 'archive');
  await host.request({ type: 'permissions', mode: 'ask' });
  assert.equal(host.status()!.permissions, 'ask');
  const selected = host.status()!.turns[1]!;
  await host.request({ type: 'forkTurn', id: selected.id, boundary: 'before' });
  assert.equal(host.status()!.permissions, 'ask');
});

test('editing a prompt resets elevated permissions before the replacement runs', async (context) => {
  const { host, sent } = await recoveryFixture(context, 'archive');
  await host.request({ type: 'permissions', mode: 'yolo', confirmed: true });
  assert.equal(host.status()!.permissions, 'yolo');
  const selected = host.status()!.turns[1]!;
  await host.request({ type: 'editPrompt', id: selected.id, text: 'replacement' });
  assert.equal(host.status()!.permissions, 'rules');
  assert.equal(sent.at(-1), 'replacement');
  assert.equal(host.status()!.turns.at(-1)!.prompt, 'replacement');
});

for (const stage of stages) {
  test(`history interruption at ${stage} reopens without replay or file/review changes`, async (context) => {
    const current = await recoveryFixture(context, stage);
    const { host, fault, sent, document } = current;
    const before = host.storedState!();
    const disk = structuredClone(fixture.disk.get(current.target));
    const dirty = document.text;
    fault.armed = true;
    const selected = host.status()!.turns[1]!;
    const request =
      stage === 'fork-save'
        ? { type: 'forkTurn', id: selected.id, boundary: 'before' }
        : { type: 'editPrompt', id: selected.id, text: 'replacement' };
    await assert.rejects(host.request(request), /injected|ambiguous/);
    assert.equal(fault.crashed, true);
    assert.equal(host.status()!.connected, ['replacement', 'final-save'].includes(stage));
    assert.equal(host.status()!.busy, false);
    await deactivate();
    fault.armed = false;
    fault.crashed = false;
    const reopened = await activate(host.extensionContext as ExtensionContext);
    fixture.provider!.resolveWebviewView(view);
    const submissions = sent.length;
    if (stage === 'verification') {
      await assert.rejects(reopened.request!({ v: 1, type: 'connect' }), /ambiguous/);
      assert.equal(reopened.status()!.connected, false);
      assert.equal(reopened.status()!.canHistory, false);
    } else await reopened.request!({ v: 1, type: 'connect' });
    assert.equal(sent.length, submissions);
    const saved = reopened.storedState!();
    assert.deepEqual(saved.changes, before.changes);
    assert.deepEqual(fixture.disk.get(current.target), disk);
    assert.equal(document.text, dirty);
    assert.equal(document.isDirty, true);
    const source = saved.sessions.find((session) => session.id === 'native-session')!;
    const rewound = ['navigation-after', 'rewind-save', 'final-save'].includes(stage);
    assert.equal(source.turns.length, rewound ? (stage === 'final-save' ? 2 : 1) : 2);
    if (['replacement', 'final-save'].includes(stage))
      assert.equal(source.turns.at(-1)!.status, 'cancelled');
    if (!['archive', 'intent', 'fork-save'].includes(stage)) {
      const archive = saved.sessions.find((session) => session.id === 'archive')!;
      assert.deepEqual(
        archive.turns.map((turn) => turn.prompt),
        ['past', 'future'],
      );
      assert.ok(archive.turns.every((turn) => turn.history?.sessionId === 'archive'));
    }
    assert.equal(saved.activeSessionId, 'native-session');
  });
}
