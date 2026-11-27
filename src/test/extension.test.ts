import test from 'node:test';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, fixture, seedFile, Uri, view } from './vscode-fixture.js';
import { setup, pendingApproval, approveNext } from './extension-setup.js';
import { OmpClient, transport } from './acp-fixture.js';
import { TerminalManager } from '../terminal.js';
import { exchangeMutations } from '../mutations.js';

const vscode = await import('vscode');
const { deactivate } = await import('../extension.js');

test('host activation publishes a CSP-protected view and rejects untrusted sidebar actions', async (context) => {
  const host = await setup(context);
  assert.match(view.webview.html, /default-src 'none'/);
  assert.match(view.webview.html, /script-src 'nonce-/);
  assert.equal(host.status()!.connected, false);
  await assert.rejects(
    host.request({ type: 'prompt', text: '/vs-omp-history unsafe' }),
    /sidebar session/,
  );
  await assert.rejects(host.request({ type: 'prompt', text: '/fork' }), /sidebar session/);
  await assert.rejects(host.request({ type: 'arbitrary', path: '/private' }), /Invalid sidebar/);
  await assert.rejects(host.request({ type: 'link', href: 'file:///private.txt' }), /web or email/);
  await host.request({ type: 'link', href: 'https://example.com' });
  await host.request({ type: 'output' });
  assert.equal(fixture.outputShown, true);
  await host.request({ type: 'openFolder' });
  assert.ok(fixture.commandCalls.some((call) => call.id === 'vscode.openFolder'));
  await assert.rejects(host.request({ type: 'attach' }), /No active editor/);
  await assert.rejects(host.request({ type: 'review', id: 'unknown' }), /active session/);
});

test('host refuses untrusted, missing and unsupported workspace roots without retaining operation ownership', async (context) => {
  const host = await setup(context);
  fixture.trusted = false;
  await assert.rejects(host.request({ type: 'connect' }), /Trust this workspace/);
  fixture.trusted = true;
  const roots = fixture.roots;
  fixture.roots = [];
  await assert.rejects(host.request({ type: 'connect' }), /Open a workspace/);
  fixture.roots = [
    { name: 'virtual', uri: Uri.from({ scheme: 'memfs', path: '/virtual' }), index: 0 },
  ];
  await assert.rejects(host.request({ type: 'connect' }), /filesystem roots/);
  fixture.roots = roots;
  await host.request({ type: 'connect' });
  assert.equal(host.status()!.connected, true);
  assert.equal(host.status()!.busy, false);
  const configuration = JSON.parse(
    await readFile(path.join(host.storage, 'session-config.json'), 'utf8'),
  );
  assert.deepEqual(configuration.tools, { xdev: false, approvalMode: 'write' });
  assert.deepEqual(configuration.bash, { direnv: 'off', autoBackground: { enabled: false } });
  assert.deepEqual(configuration.async, { enabled: false });
  assert.deepEqual(configuration.launch, { enabled: false });
  assert.ok(
    transport.started!.args.includes('read,write,todo,retain,recall,memory_edit,edit,bash'),
  );
  assert.equal(transport.started!.cwd, host.root);
});

test('host rejects remote memory backends and recovers for a safe local session', async (context) => {
  const host = await setup(context);
  transport.backend = 'remote-service';
  await assert.rejects(host.request({ type: 'connect' }), /not remote memory/);
  assert.equal(host.status()!.connecting, false);
  transport.backend = 'off';
  await host.request({ type: 'connect' });
  const configuration = JSON.parse(
    await readFile(path.join(host.storage, 'session-config.json'), 'utf8'),
  );
  assert.equal(configuration.memory.backend, 'mnemopi');
  assert.equal(configuration.mnemopi.llmMode, 'none');
});

test('host recovers from startup without an available model before accepting commands', async (context) => {
  const host = await setup(context);
  const start = OmpClient.prototype.start;
  context.after(() => {
    OmpClient.prototype.start = start;
  });
  OmpClient.prototype.start = async function (options) {
    await start.call(this, options);
    this.configOptions = [];
  };
  await assert.rejects(host.request({ type: 'connect' }), /model selector/);
  assert.equal(host.status()!.connecting, false);
  assert.equal(host.status()!.approval, undefined);
  OmpClient.prototype.start = start;
  await host.request({ type: 'connect' });
  assert.equal(host.status()!.connected, true);
});

test('host mediates streamed prompts, attachments and review without losing dirty-buffer baselines', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const target = path.join(host.root, 'file.txt');
  seedFile(target, 'disk baseline');
  fixture.editor = {
    document: new Document(Uri.file(target), 'unsaved user work'),
    selection: { isEmpty: true },
  };
  fixture.documents.push(fixture.editor.document);
  await host.request({ type: 'attach' });
  transport.onPrompt = async (blocks) => {
    assert.equal(blocks[1]!.type, 'resource');
    const client = transport.client!;
    await client.handlers.update({
      sessionId: client.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\u001b[31mAnswer\u001b[0m' },
      },
    });
    await client.handlers.write({
      sessionId: client.sessionId,
      path: target,
      content: 'agent edit',
    });
  };
  await host.request({ type: 'prompt', text: 'Change this file' });
  assert.equal(host.status()!.turns[0]!.blocks[0]!.text, 'Answer');
  assert.equal(host.status()!.turns[0]!.status, 'completed');
  assert.equal(host.storedState!().changes[0]!.before, 'unsaved user work');
  const change = host.status()!.changes[0]!;
  await host.request({ type: 'review', id: change.id });
  assert.ok(
    fixture.commandCalls.some(
      (call) => call.id === 'vscode.openWith' && call.args[1] === 'omp.inlineReview',
    ),
  );
  await host.request({ type: 'discard', id: change.id });
  assert.equal(fixture.documents[0]!.text, 'unsaved user work');
  assert.deepEqual(host.status()!.changes, []);
  assert.equal(host.status()!.attachment, undefined);
});

test('host cancellation and operation ownership reject overlapping review/config changes', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  await assert.rejects(host.request({ type: 'permissions', mode: 'all' }), /explicit confirmation/);
  await host.request({ type: 'permissions', mode: 'all', confirmed: true });
  assert.equal(host.status()!.permissions, 'all');
  await host.request({ type: 'permissionSettings' });
  assert.ok(fixture.commandCalls.some((call) => call.id === 'workbench.action.openSettings'));
  await host.request({ type: 'new' });
  assert.equal(host.status()!.permissions, 'all');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.onPrompt = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  transport.onCancel = () => {
    release();
  };
  const pending = host.request({ type: 'prompt', text: 'Wait' });
  await started;
  await assert.rejects(
    host.request({ type: 'permissions', mode: 'all', confirmed: true }),
    /current operation/,
  );
  await assert.rejects(host.request({ type: 'keepAll' }), /current operation/);
  await assert.rejects(
    host.request({ type: 'config', id: 'model', value: 'github-copilot/gpt-4.1' }),
    /current operation/,
  );
  await assert.rejects(
    transport.client!.handlers.write({
      sessionId: 'stale',
      path: path.join(host.root, 'file'),
      content: 'no',
    }),
    /session|active|turn/,
  );
  await host.request({ type: 'cancel' });
  await pending;
  assert.equal(host.status()!.busy, false);
  await host.request({ type: 'disconnect' });
  assert.equal(host.status()!.connected, false);
});

test('host handles streamed tools, plans, usage, configuration and bounded read requests', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const client = transport.client!;
  const notify = (update: SessionNotification['update']) =>
    client.handlers.update({ sessionId: client.sessionId, update });
  const target = path.join(host.root, 'read.txt');
  seedFile(target, 'first\nsecond\nthird');
  await assert.rejects(
    client.handlers.read({ sessionId: client.sessionId, path: target }),
    /active|turn|session/,
  );
  transport.onPrompt = async () => {
    assert.equal(
      await client.handlers.read({ sessionId: client.sessionId, path: target, line: 2, limit: 1 }),
      'second',
    );
    await notify({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking' },
    });
    await notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool',
      title: 'Read text',
      kind: 'read',
      status: 'in_progress',
      rawInput: { command: 'read fixture' },
    });
    await notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool output' } }],
    });
    await notify({
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect', priority: 'high', status: 'pending' }],
    });
    await notify({
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect', priority: 'high', status: 'completed' }],
    });
    await notify({ sessionUpdate: 'usage_update', used: 50, size: 100 });
    await notify({ sessionUpdate: 'config_option_update', configOptions: client.configOptions });
    await notify({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Compact' },
        { name: 'context', description: 'Context' },
      ],
    });
  };
  await host.request({ type: 'prompt', text: 'Inspect' });
  const blocks = host.status()!.turns[0]!.blocks;
  assert.equal(blocks.find((block) => block.id === 'tool')!.text, 'tool output');
  assert.equal(blocks.find((block) => block.id === 'tool')!.command, 'read fixture');
  assert.equal(blocks.filter((block) => block.id === 'plan').length, 1);
  assert.equal(host.status()!.context!.used, 50);
  assert.equal(host.status()!.canCompact, true);
  await host.request({ type: 'copyTool', id: 'tool' });
  assert.equal(fixture.clipboard, 'read fixture\ntool output');
  await host.request({ type: 'config', id: 'model', value: 'github-copilot/gpt-4.1' });
  assert.equal(host.status()!.context!.stale, true);
  await assert.rejects(
    host.request({ type: 'config', id: 'model', value: 'unsupported' }),
    /Unsupported/,
  );
  await client.handlers.update({
    sessionId: 'stale',
    update: { sessionUpdate: 'usage_update', used: 99, size: 100 },
  });
  assert.equal(host.status()!.context!.used, 50);
});

function terminalCommand(source = 'setInterval(()=>{},1000);') {
  return {
    sessionId: transport.client!.sessionId,
    command: process.execPath,
    args: ['-e', source],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  };
}

test('prompt completion disposes owned terminals without resolving file review or exposing idle execution', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const terminals = transport.client!.handlers.terminals!;
  await assert.rejects(terminals.create(terminalCommand()), /active prompt/);
  let exit!: ReturnType<typeof terminals.waitForExit>;
  transport.onPrompt = async () => {
    const handle = await terminals.create(terminalCommand());
    exit = terminals.waitForExit({ sessionId: transport.client!.sessionId, ...handle });
  };
  const prompt = host.request({ type: 'prompt', text: 'Host terminal fixture' });
  await approveNext(host);
  await prompt;
  assert.equal((await exit)._meta?.['vs-omp/termination'], 'dispose');
  assert.equal(host.status()!.busy, false);
  assert.equal(host.status()!.turns[0]!.status, 'completed');
  assert.deepEqual(host.storedState!().changes, []);
  await assert.rejects(terminals.create(terminalCommand()), /active prompt/);
  await assert.rejects(
    transport.client!.handlers.permission({
      sessionId: transport.client!.sessionId,
      options: [],
      toolCall: { toolCallId: 'unsupported' },
    }),
    /active prompt/,
  );
});

test('host native delete and paired move show operation-aware review and restore through Discard', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const source = path.join(host.root, 'source.txt');
  const destination = path.join(host.root, 'renamed.txt');
  await writeFile(source, 'baseline');
  for (const op of ['delete', 'move'] as const) {
    seedFile(source, 'baseline');
    transport.onPrompt = async () => {
      assert.equal(
        (
          await transport.client!.handlers.permission({
            sessionId: transport.client!.sessionId,
            options: [],
            toolCall: { toolCallId: 'unpermitted' },
          })
        ).outcome.outcome,
        'cancelled',
      );
      await exchangeMutations(path.join(host.storage, 'omp-sessions', 'mutations'), [
        op === 'delete'
          ? { op, path: source, before: 'baseline' }
          : { op, path: source, before: 'baseline', content: 'changed', destination },
      ]);
    };
    await host.request({ type: 'prompt', text: `Native ${op}` });
    const change = host.status()!.changes[0]!;
    assert.match(change.name, op === 'delete' ? /Deleted/ : /renamed.txt/);
    await host.request({ type: 'review', id: change.id });
    const review = [...fixture.commandCalls]
      .reverse()
      .find((call) => call.id === 'vscode.openWith')!;
    assert.equal((review.args[0] as Uri).scheme, 'omp-review');
    assert.equal(review.args[1], 'omp.inlineReview');
    await host.request({ type: 'discard', id: change.id });
    assert.equal(host.status()!.changes.length, 0);
  }
  await host.request({ type: 'prompt', text: 'Keep paired move' });
  await host.request({ type: 'keepAll' });
  assert.equal(host.status()!.changes.length, 0);
  assert.equal(
    new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(destination))),
    'changed',
  );
  seedFile(source, 'baseline');
  transport.onPrompt = () =>
    exchangeMutations(path.join(host.storage, 'omp-sessions', 'mutations'), [
      { op: 'delete', path: source, before: 'baseline' },
    ]);
  await host.request({ type: 'prompt', text: 'Discard delete in bulk' });
  await host.request({ type: 'discardAll' });
  assert.equal(host.status()!.changes.length, 0);
  assert.equal(
    new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(source))),
    'baseline',
  );
});

test('Stop during host command approval rejects late allow and preserves operation serialization', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  transport.onPrompt = async () => {
    await assert.rejects(
      transport.client!.handlers.terminals!.create(terminalCommand()),
      /cancelled|disposed/,
    );
  };
  const pending = host.request({ type: 'prompt', text: 'Await command approval' });
  const card = await pendingApproval(host);
  await assert.rejects(host.request({ type: 'new' }), /current operation/);
  await assert.rejects(host.request({ type: 'keepAll' }), /current operation/);
  await host.request({ type: 'cancel' });
  await pending;
  await host.request({ type: 'approval', id: card.id, decision: 'allow' });
  assert.equal(host.status()!.turns[0]!.status, 'cancelled');
  assert.equal(host.status()!.busy, false);
});

test('disconnect and shutdown await terminal disposal and retired connections cannot execute after reconnect', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const retired = transport.client!;
  for (const shutdown of [false, true]) {
    let running!: () => void;
    let release!: () => void;
    let exit!: ReturnType<NonNullable<typeof retired.handlers.terminals>['waitForExit']>;
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    transport.onPrompt = async () => {
      const handle = await transport.client!.handlers.terminals!.create(terminalCommand());
      exit = transport.client!.handlers.terminals!.waitForExit({
        sessionId: transport.client!.sessionId,
        ...handle,
      });
      running();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    transport.onCancel = () => release();
    const pending = host.request({ type: 'prompt', text: 'Run until host closes' });
    await approveNext(host);
    await started;
    if (shutdown) {
      await deactivate();
      release();
    } else await host.request({ type: 'disconnect' });
    await pending;
    assert.equal((await exit)._meta?.['vs-omp/termination'], 'dispose');
    assert.equal(host.status()!.connected, false);
    if (!shutdown) {
      await writeFile(
        path.join(host.storage, 'omp-sessions', `fixture_${retired.sessionId}.jsonl`),
        'test transport artifact',
      );
      await host.request({ type: 'connect' });
      await assert.rejects(retired.handlers.terminals!.create(terminalCommand()), /active prompt/);
    }
  }
});

test('unexpected connection close cancels owned processes and stale close callbacks cannot abort a new client', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const retired = transport.client!;
  let exit!: ReturnType<NonNullable<typeof retired.handlers.terminals>['waitForExit']>;
  transport.onPrompt = async () => {
    const handle = await retired.handlers.terminals!.create(terminalCommand());
    exit = retired.handlers.terminals!.waitForExit({ sessionId: retired.sessionId, ...handle });
    retired.connected = false;
    retired.handlers.closed!();
  };
  const closing = host.request({ type: 'prompt', text: 'Close unexpectedly' });
  await approveNext(host);
  await closing;
  assert.equal((await exit)._meta?.['vs-omp/termination'], 'dispose');
  assert.match(host.status()!.error, /stopped unexpectedly/);
  await writeFile(
    path.join(host.storage, 'omp-sessions', `fixture_${retired.sessionId}.jsonl`),
    'test transport artifact',
  );
  await host.request({ type: 'connect' });
  transport.onPrompt = async () => {
    retired.handlers.closed!();
    const handle = await transport.client!.handlers.terminals!.create(terminalCommand(''));
    assert.equal(
      (
        await transport.client!.handlers.terminals!.waitForExit({
          sessionId: transport.client!.sessionId,
          ...handle,
        })
      ).exitCode,
      0,
    );
  };
  const current = host.request({ type: 'prompt', text: 'Current connection stays live' });
  await approveNext(host);
  await current;
  assert.equal(host.status()!.turns.at(-1)!.status, 'completed');
});

test('host reports cleanup failure, stops OMP and retains operation/storage cleanup', async (context) => {
  const host = await setup(context, true);
  await host.request({ type: 'connect' });
  transport.onPrompt = async () => {
    const handle = await transport.client!.handlers.terminals!.create(terminalCommand(''));
    await transport.client!.handlers.terminals!.waitForExit({
      sessionId: transport.client!.sessionId,
      ...handle,
    });
    const dispose = TerminalManager.prototype.dispose;
    context.mock.method(
      TerminalManager.prototype,
      'dispose',
      async function (this: TerminalManager) {
        await dispose.call(this);
        throw new Error('injected cleanup failure');
      },
    );
  };
  const failed = assert.rejects(
    host.request({ type: 'prompt', text: 'Cleanup fault' }),
    /cleanup failed/,
  );
  await approveNext(host);
  await failed;
  assert.equal(host.status()!.turns[0]!.status, 'failed');
  assert.equal(host.status()!.busy, false);
  assert.equal(host.status()!.connected, false);
  assert.match(host.status()!.error, /cleanup failed/);
  assert.ok(fixture.logs.some((entry) => entry.includes('tool execution is disabled')));
  await assert.rejects(host.request({ type: 'connect' }), /cleanup failed/);
});
