import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { setup, pendingApproval as pending } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { fixture, seedFile, view } from './vscode-fixture.js';

type Host = Awaited<ReturnType<typeof setup>>;

function command(host: Host, executed = () => {}) {
  transport.onPrompt = async () => {
    const terminals = transport.client!.handlers.terminals!;
    const owned = {
      sessionId: transport.client!.sessionId,
      ...(await terminals.create({
        sessionId: transport.client!.sessionId,
        command: '/bin/echo',
        args: ['approved'],
      })),
    };
    assert.equal((await terminals.waitForExit(owned)).exitCode, 0);
    assert.equal(terminals.output(owned).output, 'approved\n');
    executed();
  };
  return host.request({ type: 'prompt', text: 'Run the command' }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

test('busy approval replies authorize exactly once; settings and forged scopes do not grant', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  let executions = 0;
  const result = command(host, () => executions++);
  assert.equal(host.status()!.cancellable, true);
  const card = await pending(host);
  assert.equal(host.status()!.busy, true);
  assert.equal(host.status()!.cancellable, true);
  assert.equal(fixture.warnings.length, 0);
  await host.request({ type: 'approvalSettings', id: randomUUID() });
  assert.equal(fixture.commandCalls.length, 0);
  await host.request({ type: 'approvalSettings', id: card.id });
  assert.match(JSON.stringify(fixture.commandCalls), /omp.permissions.commandRules/);
  assert.equal(host.status()!.approval!.id, card.id);
  await assert.rejects(
    host.request({ type: 'approval', id: card.id, decision: 'allow', scope: 'always' }),
    /Invalid sidebar/,
  );
  await assert.rejects(
    host.request({ type: 'approval', id: 'foreign', decision: 'allow' }),
    /Invalid sidebar/,
  );
  await host.request({ type: 'approval', id: randomUUID(), decision: 'allow' });
  assert.equal(host.status()!.approval!.id, card.id);
  await host.request({ type: 'approval', id: card.id, decision: 'allow' });
  await host.request({ type: 'approval', id: card.id, decision: 'allow' });
  assert.equal(await result, undefined);
  assert.equal(executions, 1);
  assert.equal(host.status()!.approval, undefined);
  assert.equal('approval' in host.storedState!(), false);
  assert.equal(host.status()!.permissions, 'rules');
});

test('Skip and stale replies cannot approve a later command', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const first = command(host);
  const stale = await pending(host);
  await host.request({ type: 'approval', id: stale.id, decision: 'skip' });
  assert.match(String(await first), /not approved/);
  const second = command(host);
  const current = await pending(host);
  await host.request({ type: 'approval', id: stale.id, decision: 'allow' });
  assert.equal(host.status()!.approval!.id, current.id);
  await host.request({ type: 'cancel' });
  await second;
  assert.equal(host.status()!.approvalCount, 0);
  assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
});

test('trust and deny rules are rechecked after inline approval', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const first = command(host);
  const trusted = await pending(host);
  fixture.trusted = false;
  await host.request({ type: 'approval', id: trusted.id, decision: 'allow' });
  assert.match(String(await first), /trusted workspace|not approved/);
  fixture.trusted = true;
  const second = command(host);
  const denied = await pending(host);
  fixture.configuration.set('omp.permissions.commandRules', [
    { command: ['echo'], action: 'deny' },
  ]);
  await host.request({ type: 'approval', id: denied.id, decision: 'allow' });
  assert.match(String(await second), /blocked by an OMP user rule/);
});

test('reload, view replacement, disposal and an unavailable view fail closed', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const first = command(host);
  await pending(host);
  await host.request({ type: 'ready' });
  assert.match(String(await first), /not approved/);
  const second = command(host);
  await pending(host);
  const oldMessage = fixture.messageListener!;
  const oldDispose = fixture.viewDisposed!;
  fixture.provider!.resolveWebviewView({ ...view, webview: { ...view.webview } });
  assert.match(String(await second), /not approved/);
  oldMessage({ v: 1, type: 'output' });
  oldDispose();
  assert.equal(fixture.outputShown, false);
  fixture.messageListener!({ v: 1, type: 'output' });
  await tick();
  assert.equal(fixture.outputShown, true);
  const third = command(host);
  await pending(host);
  fixture.viewDisposed!();
  assert.match(String(await third), /not approved/);
  assert.match(String(await command(host)), /not approved/);
});

test('outside file approvals bind full proposed images and cancel without mutation', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const target = path.join(host.root, '..', 'outside.txt');
  seedFile(target, 'before\n');
  transport.onPrompt = async () => {
    await transport.client!.handlers.write!({
      sessionId: transport.client!.sessionId,
      path: target,
      content: 'after\n',
    });
  };
  const write = () =>
    host.request({ type: 'prompt', text: 'Write outside' }).then(
      () => undefined,
      (error: unknown) => error,
    );
  const skipped = write();
  const first = await pending(host);
  assert.equal(first.kind, 'file');
  assert.match(first.details, /-before\n\+after/);
  await host.request({ type: 'approvalSettings', id: first.id });
  assert.equal(fixture.commandCalls.length, 0);
  await host.request({ type: 'cancel' });
  await skipped;
  assert.equal(host.status()!.changes.length, 0);
  const accepted = write();
  const second = await pending(host);
  await host.request({ type: 'approval', id: second.id, decision: 'allow' });
  assert.equal(await accepted, undefined);
  assert.equal(host.status()!.changes.length, 1);
  assert.match(host.status()!.changes[0]!.name, /outside\.txt$/);
});

test('undeliverable approval cards fail closed without hanging a prompt', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  for (const delivery of [false, 'reject'] as const) {
    fixture.delivery = delivery;
    assert.match(String(await command(host)), /not approved/);
    assert.equal(host.status()!.approvalCount, 0);
  }
  fixture.delivery = true;
});
