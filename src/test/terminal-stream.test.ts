import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { RunningTerminal, TerminalManager } from '../terminal.js';
import {
  TerminalLiveTap,
  TerminalStreamController,
  boundedLiveOutput,
  correlateTerminalBlock,
  terminalCommandText,
} from '../terminal-stream.js';

interface TestCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  outputByteLimit: number;
}

interface TestObservation {
  terminalId: string;
  toolCallId?: string;
  command: TestCommand;
}

interface TestBlock {
  id: string;
  kind: 'tool';
  text: string;
  command?: string;
  status: string;
}

interface TestTurn {
  id: string;
  status: string;
  blocks: TestBlock[];
}

type Feed = (snapshot: TerminalOutputResponse) => void;

function manualClock() {
  let next = 0;
  const callbacks = new Map<number, () => void>();
  return {
    clock: {
      schedule(callback: () => void) {
        const id = ++next;
        callbacks.set(id, callback);
        return id;
      },
      cancel(handle: unknown) {
        callbacks.delete(handle as number);
      },
    },
    tick() {
      const batch = [...callbacks.values()];
      callbacks.clear();
      for (const callback of batch) callback();
    },
  };
}

function subscriptions() {
  const listeners = new Map<string, Feed>();
  return {
    observe: (terminalId: string, listener: Feed) => {
      listeners.set(terminalId, listener);
      return () => {
        listeners.delete(terminalId);
      };
    },
    push: (terminalId: string, snapshot: TerminalOutputResponse) =>
      listeners.get(terminalId)?.(snapshot),
    listening: (terminalId: string) => listeners.has(terminalId),
  };
}

// A real shell delay proves partial output exists before exit; the deadline only
// guards a hung fixture.
function withDeadline<Value>(pending: Promise<Value>, ms: number): Promise<Value> {
  const { promise, resolve, reject } = Promise.withResolvers<Value>();
  const timer = setTimeout(() => reject(new Error('Timed out waiting for streamed output.')), ms);
  void pending.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return promise;
}

function block(id: string, command?: string, text = ''): TestBlock {
  return { id, kind: 'tool', text, command, status: 'in_progress' };
}

function turnOf(blocks: TestBlock[]): TestTurn {
  return { id: 'turn', status: 'running', blocks };
}

function observation(terminalId: string, command: string, toolCallId?: string): TestObservation {
  return {
    terminalId,
    toolCallId,
    command: {
      command: '/bin/bash',
      args: ['-l', '-c', command],
      cwd: '/tmp',
      env: {},
      outputByteLimit: 65_536,
    },
  };
}

test('terminal stream identity prefers a real tool call and exact commands in order', () => {
  assert.equal(
    terminalCommandText({ command: '/bin/bash', args: ['-l', '-c', 'echo one'] }),
    'echo one',
  );
  assert.equal(
    terminalCommandText({
      command: process.execPath,
      args: ['--input-type=module', '-e', 'console.log(1)'],
    }),
    'console.log(1)',
  );
  assert.equal(
    terminalCommandText({ command: '/usr/bin/env', args: ['--', 'echo', 'one'] }),
    '/usr/bin/env -- echo one',
  );
  const blocks = [block('b1', 'echo same'), block('b2', 'echo same')];
  assert.equal(correlateTerminalBlock(blocks, { command: 'echo same' }), 'b1');
  assert.equal(correlateTerminalBlock(blocks, { command: 'echo same' }, new Set(['b1'])), 'b2');
  assert.equal(correlateTerminalBlock(blocks, { command: 'echo other', toolCallId: 'b2' }), 'b2');
  assert.equal(
    correlateTerminalBlock(blocks, { command: 'echo same', toolCallId: 'missing' }),
    undefined,
  );
  assert.equal(
    correlateTerminalBlock([block('done', 'echo same', 'final')], { command: 'echo same' }),
    undefined,
  );
  const completed = { ...block('done', 'echo same'), status: 'completed' };
  assert.equal(correlateTerminalBlock([completed], { command: 'echo same' }), undefined);
  assert.equal(correlateTerminalBlock([block('plain')], { command: 'echo same' }), undefined);
  assert.equal(
    correlateTerminalBlock(
      [block('only', 'echo same')],
      { command: 'echo same' },
      new Set(['only']),
    ),
    undefined,
  );
});

test('live output is byte bounded without splitting UTF-8', () => {
  assert.deepEqual(boundedLiveOutput('plain'), { output: 'plain', truncated: false });
  assert.deepEqual(boundedLiveOutput('plain', 10, true), { output: 'plain', truncated: true });
  const exact = boundedLiveOutput('x'.repeat(70_000));
  assert.equal(exact.output, 'x'.repeat(65_536));
  assert.equal(exact.truncated, true);
  const split = boundedLiveOutput(`${'a'.repeat(65_535)}€`, 2);
  assert.equal(split.output, '');
  assert.equal(split.truncated, true);
  assert.equal(split.output.includes('\uFFFD'), false);
  assert.equal(Buffer.byteLength(split.output), 0);
});

test('live tap coalesces snapshots and flushes a final snapshot exactly once', () => {
  const manual = manualClock();
  const updates: { output: string; running: boolean }[] = [];
  const tap = new TerminalLiveTap({
    emit: (update) => updates.push({ output: update.output, running: update.running }),
    clock: manual.clock,
  });
  const feed = subscriptions();
  tap.watch({ terminalId: 't', command: 'echo' }, (listener) => feed.observe('t', listener));
  feed.push('t', { output: 'one', truncated: false });
  feed.push('t', { output: 'one\ntwo', truncated: false });
  assert.equal(updates.length, 0);
  manual.tick();
  assert.deepEqual(updates, [{ output: 'one\ntwo', running: true }]);
  feed.push('t', {
    output: 'one\ntwo\nthree',
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  });
  assert.deepEqual(updates.at(-1), { output: 'one\ntwo\nthree', running: false });
  assert.equal(updates.length, 2);
  feed.push('t', { output: 'late', truncated: false });
  manual.tick();
  assert.equal(updates.length, 2);
  tap.close();
});

test('live tap refuses failed subscriptions, synchronous completion and failing emits', () => {
  const manual = manualClock();
  const tap = new TerminalLiveTap({ emit: () => {}, clock: manual.clock });
  assert.doesNotThrow(() =>
    tap.watch({ terminalId: 'broken', command: 'x' }, () => {
      throw new Error('unavailable');
    }),
  );
  const updates: { output: string; running: boolean }[] = [];
  const final = new TerminalLiveTap({
    emit: (update) => updates.push({ output: update.output, running: update.running }),
    clock: manual.clock,
  });
  let stopped = 0;
  final.watch({ terminalId: 't', command: 'x' }, (listener) => {
    listener({ output: 'done', truncated: false, exitStatus: { exitCode: 0, signal: null } });
    return () => {
      stopped++;
    };
  });
  assert.deepEqual(updates, [{ output: 'done', running: false }]);
  assert.equal(stopped, 1);
  final.close();
  const failing = new TerminalLiveTap({
    emit: () => {
      throw new Error('webview');
    },
    clock: manual.clock,
  });
  const feed = subscriptions();
  failing.watch({ terminalId: 't', command: 'x' }, (listener) => feed.observe('t', listener));
  feed.push('t', { output: 'text', truncated: false });
  assert.doesNotThrow(() => manual.tick());
  failing.close();
});

test('live tap default clock cancels its pending flush on close', () => {
  const tap = new TerminalLiveTap({ emit: () => {} });
  const feed = subscriptions();
  tap.watch({ terminalId: 't', command: 'x' }, (listener) => feed.observe('t', listener));
  feed.push('t', { output: 'pending', truncated: false });
  assert.doesNotThrow(() => tap.close());
});

test('live tap close cancels pending work and tolerates failing unsubscribes', () => {
  const manual = manualClock();
  const tap = new TerminalLiveTap({ emit: () => {}, clock: manual.clock });
  const feed = subscriptions();
  const stopFailure = () => {
    throw new Error('stop');
  };
  tap.watch({ terminalId: 't', command: 'x' }, (listener) => {
    feed.observe('t', listener);
    return stopFailure;
  });
  feed.push('t', { output: 'pending', truncated: false });
  tap.stop('t');
  tap.watch({ terminalId: 't2', command: 'x' }, (listener) => feed.observe('t2', listener));
  feed.push('t2', { output: 'pending', truncated: false });
  tap.watch({ terminalId: 't3', command: 'x' }, () => stopFailure);
  assert.doesNotThrow(() => tap.close());
  assert.doesNotThrow(() => tap.close());
  assert.doesNotThrow(() => tap.stop('missing'));
  assert.doesNotThrow(() => tap.watch({ terminalId: 't4', command: 'x' }, () => () => {}));
  manual.tick();
});

test('controller maps owned terminals to the active turn and stops on authoritative output', () => {
  const manual = manualClock();
  const feed = subscriptions();
  const messages: { terminalId: string; turnId: string; blockId: string; output: string }[] = [];
  const blocks = [block('b1', 'echo same'), block('b2', 'echo same')];
  let turn: TestTurn | undefined = turnOf(blocks);
  const controller = new TerminalStreamController({
    turn: () => turn,
    observe: feed.observe,
    send: (message) => messages.push(message),
    clock: manual.clock,
  });
  controller.terminal(observation('t1', 'echo same'));
  controller.terminal(observation('t2', 'echo same'));
  feed.push('t1', { output: 'one', truncated: false });
  feed.push('t2', { output: 'two', truncated: true });
  manual.tick();
  assert.deepEqual(
    messages.map(({ terminalId, blockId, output }) => ({ terminalId, blockId, output })),
    [
      { terminalId: 't1', blockId: 'b1', output: 'one' },
      { terminalId: 't2', blockId: 'b2', output: 'two' },
    ],
  );
  assert.ok(messages.every((message) => message.turnId === 'turn'));
  blocks[0]!.text = 'authoritative';
  feed.push('t1', { output: 'late', truncated: false });
  manual.tick();
  assert.equal(messages.length, 2);
  turn = undefined;
  feed.push('t2', { output: 'late', truncated: false });
  manual.tick();
  assert.equal(messages.length, 2);
  controller.close();
  controller.close();
  controller.terminal(observation('t3', 'echo same'));
  assert.equal(feed.listening('t3'), false);
});

test('controller prefers tool-call identity and refuses ambiguous or unrelated terminals', () => {
  const manual = manualClock();
  const feed = subscriptions();
  const messages: { blockId: string; output: string }[] = [];
  const blocks = [block('call-1', 'different'), block('b2', 'echo same')];
  let turn = turnOf(blocks);
  const controller = new TerminalStreamController({
    turn: () => turn,
    observe: feed.observe,
    send: (message) => messages.push(message),
    clock: manual.clock,
  });
  controller.terminal(observation('t1', 'echo same', 'call-1'));
  controller.terminal(observation('t2', 'echo other'));
  controller.terminal(observation('t3', 'echo same', 'missing'));
  controller.terminal(observation('t4', 'echo same'));
  assert.equal(feed.listening('t2'), false);
  assert.equal(feed.listening('t3'), false);
  feed.push('t1', { output: 'preferred', truncated: false });
  manual.tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.blockId, 'call-1');
  assert.equal(messages[0]!.output, 'preferred');
  turn = { id: 'turn', status: 'completed', blocks };
  controller.terminal(observation('t5', 'echo same'));
  assert.equal(feed.listening('t5'), false);
  controller.close();
});

test('controller survives unavailable taps and failed webview posts', () => {
  const manual = manualClock();
  const feed = subscriptions();
  const blocks = [block('b1', 'echo same')];
  const turn = turnOf(blocks);
  const unavailable = new TerminalStreamController({
    turn: () => turn,
    observe: () => {
      throw new Error('tap unavailable');
    },
    send: () => {},
    clock: manual.clock,
  });
  assert.doesNotThrow(() => unavailable.terminal(observation('t1', 'echo same')));
  unavailable.close();
  let sends = 0;
  const failing = new TerminalStreamController({
    turn: () => turn,
    observe: feed.observe,
    send: () => {
      sends++;
      throw new Error('webview closed');
    },
    clock: manual.clock,
  });
  failing.terminal(observation('t2', 'echo same'));
  feed.push('t2', { output: 'text', truncated: false });
  assert.doesNotThrow(() => manual.tick());
  assert.equal(sends, 1);
  failing.close();
});

test('terminal observers cannot break capture and unresolved snapshots fail closed', async () => {
  const manifest = {
    command: '/bin/bash',
    args: ['-c', 'printf OBSERVED'],
    cwd: process.cwd(),
    env: {},
    outputByteLimit: 65_536,
  };
  const terminal = new RunningTerminal(manifest, null);
  const seen: string[] = [];
  terminal.observeOutput(() => {
    throw new Error('observer');
  });
  terminal.observeOutput((snapshot) => seen.push(snapshot.output));
  assert.equal((await terminal.done).exitCode, 0);
  assert.ok(seen.some((output) => output.includes('OBSERVED')));
  const unreadable = new RunningTerminal(manifest, null);
  unreadable.snapshot = () => {
    throw new Error('cleanup failed');
  };
  let observed = 0;
  unreadable.observeOutput(() => observed++);
  assert.equal(observed, 0);
  unreadable.terminate('fixture');
  await unreadable.done;
});

test('owned delayed command emits partial output before exit without duplication', async (context) => {
  const command = 'printf PARTIAL; sleep 0.25; printf FINAL';
  const blocks = [block('tool-1', command)];
  let controller: TerminalStreamController | undefined;
  const messages: { output: string; running: boolean }[] = [];
  const partial = Promise.withResolvers<void>();
  let observations = 0;
  const manager = new TerminalManager({
    sessionId: 'owned',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
    onTerminal: (terminal) => {
      observations++;
      controller?.terminal(terminal);
    },
  });
  context.after(() => manager.dispose());
  controller = new TerminalStreamController({
    turn: () => turnOf(blocks),
    observe: (terminalId, listener) =>
      manager.observeOutput({ sessionId: 'owned', terminalId }, listener),
    send: (message) => {
      messages.push(message);
      if (message.output === 'PARTIAL') partial.resolve();
    },
    flushMs: 40,
  });
  const handle = await manager.create({
    sessionId: 'owned',
    command: '/bin/bash',
    args: ['-c', command],
    env: [],
    outputByteLimit: 65_536,
  });
  const request = { sessionId: 'owned', ...handle };
  await withDeadline(partial.promise, 3000);
  assert.equal(messages.at(-1)!.output, 'PARTIAL');
  assert.equal(messages.at(-1)!.running, true);
  const status = await manager.waitForExit(request);
  assert.equal(status.exitCode, 0);
  assert.equal(messages.at(-1)!.output, 'PARTIALFINAL');
  assert.equal(messages.at(-1)!.output, manager.output(request).output);
  assert.equal(messages.at(-1)!.running, false);
  assert.equal(observations, 1);
  await manager.release(request);
  controller.close();
  await manager.dispose();
});
