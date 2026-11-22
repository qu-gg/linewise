import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { register } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import { fixture, reset, view, window } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const vscode = await import('vscode');
const { ChatView } = await import('../chat-view.js');
beforeEach(reset);

function create() {
  const state = {
    sessionId: 'owner',
    turns: [] as { id: string; status: string }[],
    busy: false,
    approval: undefined as { id: string } | undefined,
    question: undefined as { id: string } | undefined,
  };
  const output = vscode.window.createOutputChannel('OMP');
  const chat = new ChatView(
    { subscriptions: [], extensionUri: vscode.Uri.file('/extension') },
    output,
    () => state,
    async () => {},
  );
  chat.resolve({ ...view, show: () => {} } as never);
  return { chat, state, output };
}

test('native notification actions focus the exact pending request without deciding it or starting a prompt', async (context) => {
  const shown: string[][] = [];
  context.mock.method(window, 'showInformationMessage', async (text: string, action: string) => {
    shown.push([text, action]);
    return action;
  });
  const { chat, state } = create();
  state.approval = { id: 'approval' };
  chat.publish();
  await tick();
  assert.deepEqual(shown, [['OMP: Need approval', 'Review Approval']]);
  assert.deepEqual(state.approval, { id: 'approval' });
  assert.equal(fixture.commandCalls.filter((call) => call.id === 'omp.chat.focus').length, 1);
  assert.ok(
    fixture.messages.some(
      (message: unknown) => (message as { type: string }).type === 'focusAttention',
    ),
  );
  chat.publish();
  assert.equal(shown.length, 1);
  state.approval = undefined;
  state.question = { id: 'question' };
  chat.publish();
  await tick();
  assert.deepEqual(shown[1], ['OMP: Has questions', 'Answer Questions']);
  state.question = undefined;
  state.turns = [{ id: 'turn', status: 'running' }];
  state.busy = true;
  chat.publish();
  state.turns[0]!.status = 'completed';
  state.busy = false;
  chat.publish();
  await tick();
  assert.deepEqual(shown[2], ['OMP: Session finished', 'Open Session']);
  chat.dispose();
});

test('late native toast actions recheck ownership both before and after the focus command', async (context) => {
  let choose!: (value: string) => void;
  context.mock.method(
    window,
    'showInformationMessage',
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  const { chat, state } = create();
  state.approval = { id: 'first' };
  chat.publish();
  state.approval = { id: 'second' };
  choose('Review Approval');
  await tick();
  assert.equal(fixture.commandCalls.length, 0);
  context.mock.method(vscode.commands, 'executeCommand', async () => {
    state.sessionId = 'foreign';
  });
  chat.publish();
  choose('Review Approval');
  await tick();
  assert.equal(
    fixture.messages.some(
      (message: unknown) => (message as { type: string }).type === 'focusAttention',
    ),
    false,
  );
  chat.dispose();
});

test('foreground and disabled notifications remain suppressed; dismissed or failed toasts do not cancel requests', async (context) => {
  const shown: string[] = [];
  context.mock.method(window, 'showInformationMessage', async (text: string) => {
    shown.push(text);
    return undefined;
  });
  const { chat, state, output } = create();
  await chat.localAction({ v: 1, type: 'focus', focused: true });
  state.question = { id: 'foreground' };
  chat.publish();
  assert.deepEqual(shown, []);
  await chat.localAction({ v: 1, type: 'focus', focused: false });
  chat.publish();
  assert.deepEqual(shown, []);
  fixture.configuration.set('omp.notifications.enabled', false);
  state.question = { id: 'disabled' };
  chat.publish();
  assert.deepEqual(shown, []);
  fixture.configuration.set('omp.notifications.enabled', true);
  state.question = { id: 'dismissed' };
  chat.publish();
  await tick();
  assert.deepEqual(state.question, { id: 'dismissed' });
  assert.equal(fixture.commandCalls.length, 0);
  const logs: string[] = [];
  context.mock.method(output, 'appendLine', (text: string) => logs.push(text));
  context.mock.method(window, 'showInformationMessage', async () => {
    throw new Error('private failure details');
  });
  state.question = { id: 'failed' };
  chat.publish();
  await tick();
  assert.deepEqual(logs, ['OMP notification could not be displayed.']);
  assert.deepEqual(state.question, { id: 'failed' });
  chat.dispose();
});
