import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, seedFile } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';

test('a stale historical edit retains session state and returns a failed editing acknowledgement', async (context) => {
  const host = await setup(context);
  await assert.rejects(host.request({ type: 'editPrompt', id: 'missing', text: 'Replacement' }));
  assert.equal(host.status()!.busy, false);
  assert.deepEqual(host.status()!.turns, []);
});

test('host hunk actions navigate exact recorded diffs and preserve accepted text across later writes', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const target = path.join(host.root, 'hunks.txt');
  const before = Array.from({ length: 16 }, (_, index) => `line ${index}\n`).join('');
  seedFile(target, before);
  transport.onPrompt = async () => {
    await transport.client!.handlers.write({
      sessionId: transport.client!.sessionId,
      path: target,
      content: before.replace('line 0', 'kept').replace('line 15', 'discarded'),
    });
  };
  await host.request({ type: 'prompt', text: 'Change two areas' });
  const change = host.status()!.changes[0]!;
  assert.equal(change.operations[0]!.kind, 'edit');
  assert.equal(change.operations[0]!.turnId, host.status()!.turns[0]!.id);
  assert.equal(change.operations[0]!.tool, 'write');
  const [first, second] = change.hunks;
  assert.ok(first && second);
  await host.request({ type: 'hunkReview', id: change.id, hunkId: second.id });
  assert.ok(fixture.commandCalls.some((call) => call.id === 'vscode.diff'));
  await host.request({ type: 'hunkKeep', id: change.id, hunkId: first.id });
  await assert.rejects(
    host.request({ type: 'hunkDiscard', id: change.id, hunkId: first.id }),
    /stale/,
  );
  await host.request({ type: 'hunkDiscard', id: change.id, hunkId: second.id });
  assert.deepEqual(host.status()!.changes, []);
  await assert.rejects(
    host.request({ type: 'hunkKeep', id: change.id, hunkId: second.id }),
    /active session/,
  );
  await host.request({ type: 'prompt', text: 'Edit again' });
  assert.equal(host.storedState!().changes[0]!.before, before.replace('line 0', 'kept'));
});
