import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TerminalOutputResponse } from '@agentclientprotocol/sdk';
import type * as vscode from 'vscode';
import { window, fixture as hostFixture, reset, Uri } from './vscode-fixture.js';
import { exchangeResult } from '../mutations.js';
import { TerminalStreamController, terminalCommandText } from '../terminal-stream.js';
register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
// Host adapters import vscode, so they must load after the test loader registers.
const { TerminalManager } = await import('../terminal.js');
const { PtyTerminal } = await import('../terminal-pty.js');
const { createHostTerminal } = await import('../host-terminals.js');
const { HostTools } = await import('../host-tools.js');

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

function block(id: string, command?: string, text = ''): TestBlock {
  return { id, kind: 'tool', text, command, status: 'in_progress' };
}

function turnOf(blocks: TestBlock[]): TestTurn {
  return { id: 'turn', status: 'running', blocks };
}

// These integration cases deliberately run a real delayed shell so the partial
// output exists before process exit; the deadline only guards a hung fixture.
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

async function hostToolsFixture(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-stream-'));
  hostFixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const directory = path.join(cwd, 'private', 'mutations');
  const observed: TestObservation[] = [];
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
    directory,
    async () => true,
  );
  context.after(async () => {
    await tools.finish();
    await rm(cwd, { recursive: true, force: true });
  });
  const scope = {
    sessionId: 'native',
    owner: 'local',
    cwd,
    signal: abort.signal,
    valid: () => true,
    observeTerminal: (terminal: TestObservation) => {
      observed.push(terminal);
    },
  };
  return { tools, scope, directory, observed };
}

test('owned shell output streams before exit and the final snapshot is exact', async (context) => {
  const { tools, scope, directory, observed } = await hostToolsFixture(context);
  const command = 'printf HOST_PARTIAL; sleep 0.2; printf HOST_FINAL';
  const blocks = [block('call-1', command)];
  let controller: TerminalStreamController | undefined;
  const messages: { output: string; running: boolean; blockId: string }[] = [];
  const partial = Promise.withResolvers<void>();
  controller = new TerminalStreamController({
    turn: () => turnOf(blocks),
    observe: (terminalId, listener) =>
      tools.observeOutput({ sessionId: 'native', terminalId }, listener),
    send: (message) => {
      messages.push(message);
      if (message.output.includes('HOST_PARTIAL')) partial.resolve();
    },
    flushMs: 30,
  });
  scope.observeTerminal = (terminal) => {
    observed.push(terminal);
    controller!.terminal(terminal);
  };
  await tools.run(scope, async () => {
    const response = await exchangeResult(
      directory,
      [
        {
          op: 'shell',
          request: {
            command,
            pty: false,
            visibility: 'hidden',
            action: 'start',
          },
        },
      ],
      undefined,
      'call-1',
    );
    const result = JSON.parse(response!);
    const request = { sessionId: 'native', terminalId: result.jobId };
    await withDeadline(partial.promise, 3000);
    const partialMessage = messages.find((message) => message.output.includes('HOST_PARTIAL'));
    assert.ok(partialMessage);
    assert.equal(partialMessage.output.includes('HOST_FINAL'), false);
    assert.equal(partialMessage.running, true);
    assert.equal(partialMessage.blockId, 'call-1');
    await tools.waitForExit(request);
    const final = messages.at(-1)!;
    assert.equal(final.output, (await tools.output(request)).output);
    assert.ok(final.output.includes('HOST_PARTIAL'));
    assert.ok(final.output.includes('HOST_FINAL'));
    assert.equal(final.output.split('HOST_PARTIAL').length, 2);
    assert.equal(final.running, false);
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.toolCallId, 'call-1');
  assert.equal(terminalCommandText(observed[0]!.command), command);
  controller.close();
});

test('observation failure cannot cancel an owned command', async () => {
  const manager = new TerminalManager({
    sessionId: 'owned',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
    onTerminal: () => {
      throw new Error('tap failed');
    },
  });
  const handle = await manager.create({
    sessionId: 'owned',
    command: '/bin/bash',
    args: ['-c', 'printf OK'],
    env: [],
    outputByteLimit: 65_536,
  });
  const request = { sessionId: 'owned', ...handle };
  await manager.waitForExit(request);
  assert.equal(manager.output(request).output, 'OK');
  await manager.release(request);
  await manager.dispose();
});

test('PTY output observers stream snapshots until exit', async () => {
  const terminal = new PtyTerminal(
    {
      command: '/bin/bash',
      args: ['-c', 'printf PTY_LIVE'],
      cwd: process.cwd(),
      env: {},
      outputByteLimit: 65_536,
    },
    null,
    () => {},
  );
  const seen: string[] = [];
  const unsubscribe = terminal.observeOutput((snapshot) => seen.push(snapshot.output));
  assert.equal((await terminal.done).exitCode, 0);
  unsubscribe();
  assert.ok(seen.some((output) => output.includes('PTY_LIVE')));
});

test('public host terminal queues output listeners until its backend opens', async (context) => {
  let pty!: vscode.Pseudoterminal;
  context.mock.method(window, 'createTerminal', (options: unknown) => {
    pty = (options as vscode.ExtensionTerminalOptions).pty;
    return { show: () => {}, dispose: () => pty.close() };
  });
  const abort = new AbortController();
  const terminal = createHostTerminal(
    {
      command: '/bin/bash',
      args: ['-c', 'printf READY'],
      cwd: process.cwd(),
      env: {},
      outputByteLimit: 65_536,
    },
    null,
    { pty: false, visibility: 'background' },
    { signal: abort.signal, valid: () => true },
  )!;
  context.after(async () => {
    terminal.terminate('fixture');
    await terminal.done;
  });
  const snapshots: TerminalOutputResponse[] = [];
  const unsubscribe = terminal.observeOutput!((snapshot) => snapshots.push(snapshot));
  assert.equal(snapshots.length, 0);
  pty.open(undefined);
  assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
  assert.equal(snapshots.at(-1)?.output, 'READY');
  unsubscribe();
  terminal.terminate('fixture');
  await terminal.done;
  const settled = snapshots.length;
  pty.open(undefined);
  const late = terminal.observeOutput!((snapshot) => snapshots.push(snapshot));
  late();
  assert.equal(snapshots.length, settled);
});
