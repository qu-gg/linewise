import { AgentApp, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationBroker } from '../mutations.js';
import { createClientApp } from '../acp.js';
import installHistory, { exchangeHistory } from '../history.js';
import type { HistoryApi } from '../history.js';
import type { GuardEvent } from '../omp-guard.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { default: installGuard, guardReason } = await import('../omp-guard.js');

test('official SDK transports streamed updates and mediated writes through typed handlers', async () => {
  const seen: string[] = [];
  const agent = new AgentApp()
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: [],
    }))
    .onRequest('session/new', async ({ client }) => {
      await client.request('fs/write_text_file', {
        sessionId: 'session',
        path: '/test.txt',
        content: 'new',
      });
      await client.notify('session/update', {
        sessionId: 'session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      });
      return { sessionId: 'session' };
    });
  const connection = createClientApp({
    update: async (notification) => {
      seen.push(notification.update.sessionUpdate);
    },
    read: async () => 'content',
    write: async (request) => {
      seen.push(request.content);
    },
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }).connect(agent);
  try {
    await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await connection.agent.request('session/new', { cwd: '/test', mcpServers: [] });
    assert.deepEqual(seen, ['new', 'agent_message_chunk']);
  } finally {
    connection.close();
  }
});

test('denied mediated writes propagate as failures instead of succeeding silently', async () => {
  let writeAttempted = false;
  const agent = new AgentApp()
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: [],
    }))
    .onRequest('session/new', async ({ client }) => {
      await client.request('fs/write_text_file', {
        sessionId: 'session',
        path: '/private.txt',
        content: 'no',
      });
      return { sessionId: 'session' };
    });
  const connection = createClientApp({
    update: async () => {},
    read: async () => '',
    write: async () => {
      writeAttempted = true;
      throw new Error('Not approved');
    },
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }).connect(agent);
  try {
    await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await assert.rejects(connection.agent.request('session/new', { cwd: '/test', mcpServers: [] }));
    assert.equal(writeAttempted, true);
  } finally {
    connection.close();
  }
});

async function terminalDenials(): Promise<void> {
  const agent = new AgentApp().onRequest('session/new', async ({ client }) => {
    await assert.rejects(
      client.request('terminal/create', { sessionId: 'session', command: 'unapproved-command' }),
      { code: -32603 },
    );
    for (const method of [
      'terminal/output',
      'terminal/wait_for_exit',
      'terminal/kill',
      'terminal/release',
    ] as const) {
      await assert.rejects(
        client.request(method, { sessionId: 'session', terminalId: 'unowned-terminal' }),
        { code: -32603 },
      );
    }
    return { sessionId: 'session' };
  });
  const connection = createClientApp({
    update: async () => {},
    read: async () => '',
    write: async () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }).connect(agent);
  try {
    await connection.agent.request('session/new', { cwd: '/test', mcpServers: [] });
  } finally {
    connection.close();
  }
}

test('all terminal protocol methods fail closed when no approved backend exists', terminalDenials);

test('pre-execution policy rejects unreviewable mutation routes and allows plain text writes', () => {
  for (const target of [
    'xd://bash',
    'config://tools',
    'a.zip:entry',
    'a.zip/entry.txt',
    'data.db:rows:1',
    '../escape.txt',
    '[a.txt#TAG]',
    '~/private.txt',
  ]) {
    assert.ok(guardReason({ toolName: 'write', input: { path: target, content: 'no' } }), target);
  }
  for (const toolName of ['bash', 'edit', 'delete', 'move', 'eval', 'task', 'lsp', 'unknown']) {
    assert.ok(guardReason({ toolName, input: {} }), toolName);
  }
  assert.ok(guardReason({ toolName: 'write', input: { path: 'script.sh', content: '#!/bin/sh' } }));
  assert.equal(
    guardReason({
      toolName: 'write',
      input: { path: 'src/hello.ts', content: 'export const hello = true;\n' },
    }),
    undefined,
  );
  assert.equal(guardReason({ toolName: 'read', input: { path: 'README.md' } }), undefined);
  assert.equal(
    guardReason({ toolName: 'edit', input: { input: '[file.txt#ABCD]\nREM' } }),
    undefined,
  );
  for (const option of ['async', 'pty', 'name', 'ready', 'cwd', 'timeout'])
    assert.ok(guardReason({ toolName: 'bash', input: { command: 'true', [option]: true } }));
  assert.equal(guardReason({ toolName: 'bash', input: { command: 'true' } }), undefined);
});

async function unavailableHistory(directory: string, send: (text: string) => Promise<void>) {
  const before = await exchangeHistory(directory, send, { action: 'inspect' });
  assert.equal(before.entries.length, 2);
  await assert.rejects(readFile(path.join(directory, 'missing')));
  for (const operation of [
    { sessionId: 'other', leafId: 'future', entryId: 'future' },
    { sessionId: 'native', leafId: 'past', entryId: 'future' },
    { sessionId: 'native', leafId: 'future', entryId: 'unknown' },
  ])
    await assert.rejects(exchangeHistory(directory, send, { action: 'navigate', ...operation }));
}

test('private history control validates targets, refuses stale/busy operations, and cleans request files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omp-history-'));
  const previous = process.env.VS_OMP_HISTORY_DIR;
  process.env.VS_OMP_HISTORY_DIR = directory;
  let handler!: Parameters<HistoryApi['registerCommand']>[1]['handler'];
  let entries = [
    { id: 'past', parentId: null, type: 'message', message: { role: 'user' } },
    { id: 'future', parentId: 'past', type: 'message', message: { role: 'user' } },
  ];
  let idle = true;
  let navigations = 0;
  let injectSummary = false;
  const originalEntries = structuredClone(entries);
  const context: Parameters<typeof handler>[1] = {
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => 'native',
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
    },
    navigateTree: async (target, options) => {
      assert.equal(options.summarize, false);
      navigations++;
      entries = entries.slice(
        0,
        entries.findIndex((entry) => entry.id === target),
      );
      if (injectSummary)
        entries.push({
          id: 'injected-summary',
          parentId: entries.at(-1)?.id ?? null,
          type: 'branch_summary',
          message: { role: 'assistant' },
        });
      return { cancelled: false };
    },
  };
  try {
    installHistory({
      registerCommand: (_name, command) => {
        handler = command.handler;
      },
      appendEntry: () => {},
    });
    const send = async (text: string) => handler(text.split(' ')[1]!, context);
    await assert.rejects(handler('../../escape', context));
    await unavailableHistory(directory, send);
    idle = false;
    await assert.rejects(exchangeHistory(directory, send, { action: 'inspect' }), /idle/);
    idle = true;
    assert.equal(navigations, 0);
    const after = await exchangeHistory(directory, send, {
      action: 'navigate',
      sessionId: 'native',
      leafId: 'future',
      entryId: 'future',
    });
    assert.deepEqual(
      after.entries.map((entry) => entry.id),
      ['past'],
    );
    assert.equal(navigations, 1);
    entries = originalEntries;
    injectSummary = true;
    await assert.rejects(
      exchangeHistory(directory, send, {
        action: 'navigate',
        sessionId: 'native',
        leafId: 'future',
        entryId: 'future',
      }),
      /exact requested prefix/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (previous === undefined) delete process.env.VS_OMP_HISTORY_DIR;
    else process.env.VS_OMP_HISTORY_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('installed guard pins tools and refuses private artifacts, symlink aliases and invalid reads', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omp-guard-'));
  const original = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(async () => {
    if (original === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = original;
    await rm(directory, { recursive: true, force: true });
  });
  const artifacts = path.join(directory, 'private');
  await mkdir(artifacts);
  process.env.VS_OMP_ARTIFACTS_ROOT = artifacts;
  let start!: () => Promise<void>;
  let guard!: (
    event: GuardEvent,
    context: { cwd: string },
  ) => Promise<{ block: true; reason: string } | undefined>;
  let tools: string[] = [];
  await installGuard(
    {
      registerTool: () => {},
      registerCommand: () => {},
      appendEntry: () => {},
      on: (event, handler) => {
        if (event === 'session_start') start = handler as typeof start;
        else guard = handler as typeof guard;
      },
      setActiveTools: async (names) => {
        tools = names;
      },
    },
    async () => {},
  );
  await start();
  assert.deepEqual(tools, 'read,write,todo,retain,recall,memory_edit,edit,bash'.split(','));
  const invoke = (toolName: string, target: string) =>
    guard({ toolName, input: { path: target, content: 'text' } }, { cwd: directory });
  await writeFile(path.join(artifacts, 'history.txt'), 'private');
  await symlink(path.join(artifacts, 'history.txt'), path.join(directory, 'alias.txt'));
  for (const target of ['private/history.txt', 'alias.txt', '.omp/agent/sessions/internal.txt'])
    assert.equal((await invoke('write', target))?.block, true);
  await writeFile(path.join(directory, 'normal.txt'), 'text');
  assert.equal(await invoke('read', 'normal.txt'), undefined);
  await mkdir(path.join(directory, 'folder.txt'));
  assert.equal((await invoke('read', 'folder.txt'))?.block, true);
  await writeFile(path.join(directory, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await invoke('read', 'large.txt'))?.block, true);
  assert.equal((await invoke('bash', 'normal.txt'))?.block, true);
  assert.equal(await invoke('todo', ''), undefined);
  const call = { toolName: 'bash', toolCallId: randomUUID(), input: { command: 'true' } };
  assert.equal((await guard(call, { cwd: directory }))?.block, true);
  const broker = new MutationBroker(
    path.join(artifacts, 'mutations'),
    async () => null,
    new AbortController().signal,
  );
  await broker.start();
  try {
    assert.equal(await guard(call, { cwd: directory }), undefined);
    assert.equal(await broker.permit(call.toolCallId, JSON.stringify(call.input)), true);
    assert.equal(
      (await guard({ ...call, toolCallId: undefined }, { cwd: directory }))?.block,
      true,
    );
    assert.equal(
      await guard(
        { toolName: 'edit', input: { input: '[normal.txt#ABCD]\nREM' } },
        { cwd: directory },
      ),
      undefined,
    );
  } finally {
    await broker.close();
  }
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  assert.equal((await guard(call, { cwd: directory }))?.block, true);
  assert.equal((await invoke('write', 'normal.txt'))?.block, true);
});
