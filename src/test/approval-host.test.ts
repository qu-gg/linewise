import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { setup, pendingApproval as pending } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { fixture, seedFile, view } from './vscode-fixture.js';
import { installNativeQuestions } from '../native-questions.js';
import type { NativeEditApi } from '../native-edit.js';

type Host = Awaited<ReturnType<typeof setup>>;
const { HostTools } = await import('../host-tools.js');

function questionCommand(host: Host, context: Parameters<typeof setup>[0]) {
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(host.storage, 'omp-sessions');
  context.after(() => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
  });
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeQuestions({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  let answer = '';
  transport.onPrompt = async () => {
    const result = (await tool.execute(
      randomUUID(),
      {
        questions: [
          {
            header: 'Format',
            question: 'Choose a format',
            options: [{ label: 'JSON' }, { label: 'Text' }],
          },
        ],
      },
      undefined,
      undefined,
      { cwd: host.root, sessionManager: { getSessionId: () => 'native-session' } },
    )) as { content: { text: string }[] };
    answer = result.content[0]!.text;
  };
  return () =>
    host.request({ type: 'prompt', text: 'Ask for the format' }).then(
      () => (answer ? JSON.parse(answer) : undefined),
      (error: unknown) => error,
    );
}

async function pendingQuestion(host: Host) {
  const deadline = Date.now() + 5000;
  while (!host.status()!.question) {
    assert.ok(Date.now() < deadline, 'question did not become visible');
    await tick();
  }
  return host.status()!.question!;
}

test('production broker uses owned chat questions and exact explicit answers without native dialog fallback', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const ask = questionCommand(host, context);
  const result = ask();
  const card = await pendingQuestion(host);
  assert.equal(host.status()!.busy, true);
  await host.request({ type: 'questionAnswer', id: 'foreign', answers: [{ selected: ['JSON'] }] });
  assert.equal(host.status()!.question!.id, card.id);
  await assert.rejects(
    host.request({ type: 'questionAnswer', id: card.id, answers: [{ selected: ['invented'] }] }),
    /offered answer/,
  );
  await host.request({
    type: 'questionAnswer',
    id: card.id,
    answers: [{ selected: ['JSON'], freeText: 'and this' }],
  });
  assert.deepEqual(await result, {
    status: 'answered',
    answers: { Format: { selected: ['JSON'], freeText: 'and this' } },
  });
  await host.request({ type: 'questionAnswer', id: card.id, answers: [{ selected: ['Text'] }] });
  assert.equal(host.status()!.question, undefined);
  assert.equal(host.status()!.permissions, 'rules');
  const cancelled = ask();
  const next = await pendingQuestion(host);
  await host.request({ type: 'questionCancel', id: next.id });
  assert.equal((await cancelled).status, 'cancelled');
});

for (const scenario of ['ready', 'replace', 'dispose', 'stop', 'trust'] as const) {
  test(`owned chat questions retire on ${scenario} without accepting stale answers`, async (context) => {
    const host = await setup(context);
    await host.request({ type: 'connect' });
    const ask = questionCommand(host, context);
    const result = ask();
    const card = await pendingQuestion(host);
    if (scenario === 'ready') await host.request({ type: 'ready' });
    if (scenario === 'replace')
      fixture.provider!.resolveWebviewView({ ...view, webview: { ...view.webview } });
    if (scenario === 'dispose') fixture.viewDisposed!();
    if (scenario === 'stop') await host.request({ type: 'cancel' });
    if (scenario === 'trust') {
      fixture.trusted = false;
      await host.request({
        type: 'questionAnswer',
        id: card.id,
        answers: [{ selected: ['JSON'] }],
      });
    }
    const outcome = await result;
    if (scenario === 'stop') {
      assert.equal(outcome, undefined);
      assert.equal(host.status()!.turns.at(-1)!.status, 'cancelled');
    }
    fixture.trusted = true;
    assert.equal(host.status()!.question, undefined);
    await host.request({ type: 'questionAnswer', id: card.id, answers: [{ selected: ['JSON'] }] });
    if (scenario === 'dispose') assert.equal((await ask()).status, 'cancelled');
  });
}

test('undeliverable chat questions cancel rather than hanging or falling back to native input', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const ask = questionCommand(host, context);
  for (const delivery of [false, 'reject'] as const) {
    fixture.delivery = delivery;
    assert.equal((await ask()).status, 'cancelled');
    assert.equal(host.status()!.questionCount, 0);
  }
  fixture.delivery = true;
});

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

test('cancelled terminal pickers restore their owning view without reviving disposed views', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const sessionId = host.status()!.sessionId!;
  const shown: boolean[] = [];
  const focusedView = { ...view, show: (preserveFocus: boolean) => shown.push(preserveFocus) };
  fixture.provider!.resolveWebviewView(focusedView);
  context.mock.method(
    HostTools.prototype,
    'pickTerminal',
    async (onCancel?: (id: string) => void) => onCancel?.(sessionId),
  );
  await host.request({ type: 'terminals' });
  assert.deepEqual(shown, [false]);
  const messages = fixture.messages as { v: number; type: string; sessionId?: string }[];
  assert.deepEqual(messages.filter((message) => message.type === 'focusTerminals').at(-1), {
    v: 1,
    type: 'focusTerminals',
    sessionId,
  });
  fixture.viewDisposed!();
  await host.request({ type: 'terminals' });
  assert.equal(shown.length, 1);
  assert.equal(messages.filter((message) => message.type === 'focusTerminals').length, 1);
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
