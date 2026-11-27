import { AgentApp, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClientApp } from '../acp.js';
import installHistory, { exchangeHistory } from '../history.js';
import type { HistoryApi } from '../history.js';

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
  assert.equal(
    guardReason({
      toolName: 'write',
      input: { path: 'src/shebang.ts', content: 'const marker = "#!";\n' },
    }),
    undefined,
  );
  assert.equal(
    guardReason({
      toolName: 'write',
      input: { path: 'src/lib.rs', content: '#![allow(dead_code)]\nfn main() {}\n' },
    }),
    undefined,
  );
  assert.equal(guardReason({ toolName: 'read', input: { path: 'README.md' } }), undefined);
  assert.equal(guardReason({ toolName: 'read', input: { path: '.' } }), undefined);
  assert.equal(
    guardReason({ toolName: 'edit', input: { input: '[file.txt#ABCD]\nREM' } }),
    undefined,
  );
  for (const option of ['async', 'name', 'ready', 'cwd', 'timeout'])
    assert.ok(guardReason({ toolName: 'bash', input: { command: 'true', [option]: true } }));
  assert.equal(guardReason({ toolName: 'bash', input: { command: 'true' } }), undefined);
});

test('question guard admits bounded choices and rejects unknown or invalid question input', () => {
  assert.equal(
    guardReason({
      toolName: 'ask',
      input: {
        questions: [
          { header: 'Format', question: 'Choose a format', options: [{ label: 'JSON' }] },
        ],
      },
    }),
    undefined,
  );
  assert.match(
    guardReason({ toolName: 'ask', input: { questions: [] } })!,
    /Invalid bounded question/,
  );
  assert.ok(
    guardReason({
      toolName: 'ask',
      input: { questions: [{ header: 'Run', question: 'Run?', command: 'arbitrary' }] },
    }),
  );
});

test('shell guard accepts strict defaults and explicit PTY without enabling detached modes', () => {
  for (const input of [
    { command: 'pwd && ls -la', timeout: null, cwd: null, pty: true },
    { command: 'ls -la', timeout: null, cwd: null, pty: null },
    { command: 'ls -la', timeout: null, cwd: '/workspace', pty: false },
    { command: 'ls', timeout: 0, cwd: '/workspace', pty: null },
    { command: 'ls', timeout: 120, cwd: '.', pty: false },
    { command: 'ls', timeout: 5, cwd: '', i: 'Listing repository entries' },
  ])
    assert.equal(guardReason({ toolName: 'bash', input }), undefined);
  for (const input of [
    { timeout: -1 },
    { timeout: 121 },
    { timeout: NaN },
    { timeout: Infinity },
    { timeout: '10' },
    { cwd: 1 },
    { cwd: 'file:///workspace' },
    { cwd: '../outside' },
    { visibility: 'unknown' },
    { pty: 'false' },
    { async: false },
    { name: null },
    { ready: {} },
    { unknown: null },
  ])
    assert.ok(guardReason({ toolName: 'bash', input: { command: 'ls', ...input } }));
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

test('default guard registers mediated edit and shell tools and validates owned jobs', async () => {
  const registered: string[] = [];
  let before!: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;
  await installGuard({
    registerTool: (tool) => registered.push(tool.name),
    on: (event: string, handler: unknown) => {
      if (event === 'before_agent_start') before = handler as typeof before;
    },
    registerCommand: () => {},
    appendEntry: () => {},
    setActiveTools: async () => {},
  });
  assert.deepEqual(registered, [
    'edit',
    'bash',
    'editor',
    'ask',
    'browser',
    'rename',
    'task',
    'fetch',
    'code_action',
    'notebook_edit',
  ]);
  const prompt = before({ systemPrompt: 'Existing instructions.' })!.systemPrompt;
  assert.ok(prompt.startsWith('Existing instructions.'));
  assert.match(prompt, /approval and execution have no elapsed-time deadline by default/i);
  assert.equal(before({ systemPrompt: prompt }), undefined);
  for (const action of ['output', 'wait']) {
    const input = { action, jobId: randomUUID() };
    assert.equal(guardReason({ toolName: 'bash', input }), undefined);
  }
  for (const input of [
    { action: 'wait', jobId: 'foreign' },
    { action: 'wait', jobId: randomUUID(), waitMs: 1 },
    { action: 'wait', jobId: randomUUID(), timeout: 1 },
    { action: 'wait', jobId: randomUUID(), command: 'pwd' },
  ])
    assert.ok(guardReason({ toolName: 'bash', input }));
  assert.ok(guardReason({ toolName: 'bash', input: { action: 'stop', jobId: 'foreign' } }));
  assert.equal(guardReason({ toolName: 'editor', input: { action: 'diagnostics' } }), undefined);
  assert.ok(
    guardReason({ toolName: 'editor', input: { action: 'execute', command: 'arbitrary' } }),
  );
});

test('read guard accepts local filesystem targets and native line selectors', () => {
  for (const target of [
    'src/nested/file.ts:59-260',
    'src/nested/file.ts:raw',
    'assets/icon.png',
    'state.sqlite',
    'data.zip',
    'src/file#name.[x]',
    '../outside',
  ])
    assert.equal(guardReason({ toolName: 'read', input: { path: target } }), undefined, target);
  for (const target of ['', '\0', 'https://example.com/file', 'omp://session'])
    assert.ok(guardReason({ toolName: 'read', input: { path: target } }), target);
});
