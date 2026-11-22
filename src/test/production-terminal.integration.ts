import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TerminalManager } from '../terminal.js';
import { createHostTerminal } from '../host-terminals.js';
import type { ManagedTerminal } from '../terminal.js';
import { HostTools } from '../host-tools.js';
import { WorkspaceFiles } from '../workspace.js';
import { PathGuard, ReviewJournal } from '../review.js';
import { nativeSession } from './native-session.js';
import { promptBlocks } from '../acp.js';

function bounded<Value>(pending: PromiseLike<Value>): Promise<Value> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(pending),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Production terminal fixture deadline.')), 20000);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function fileSignal(target: string): Promise<void> {
  let watcher: ReturnType<typeof watch>;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        const inspect = () => {
          void readFile(target).then(
            () => resolve(),
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') reject(error);
            },
          );
        };
        watcher = watch(path.dirname(target), (_event, file) => {
          if (file === path.basename(target)) inspect();
        });
        watcher.once('error', reject);
        inspect();
      }),
    );
  } finally {
    watcher!?.close();
  }
}

function startCommand(
  manager: TerminalManager,
  home: string,
  expectedPath: string,
  signal: AbortSignal,
) {
  return bounded(
    manager.create(
      {
        sessionId: 'production-fixture',
        command: '/bin/bash',
        args: [
          '--noprofile',
          '--norc',
          '-c',
          'printf READY; IFS= read -rs value; printf "%s" "$value"; test "$value" = "$(cat "$1")"',
          'omp-fixture',
          expectedPath,
        ],
        cwd: home,
        env: [
          { name: 'HOME', value: home },
          { name: 'PATH', value: '/usr/bin:/bin' },
        ],
      },
      null,
      signal,
      { pty: true, visibility: 'background' },
    ),
  );
}

function productionManager(home: string, abort: AbortController) {
  let approvals = 0;
  let terminal: vscode.Terminal | undefined;
  let controlled: ManagedTerminal | undefined;
  const opened = vscode.window.onDidOpenTerminal((candidate) => {
    if (/^OMP [a-f0-9]{8}$/.test(candidate.name)) terminal = candidate;
  });
  const manager = new TerminalManager({
    sessionId: 'production-fixture',
    cwd: home,
    signal: abort.signal,
    approve: async () => {
      approvals++;
      return true;
    },
    launch: (command, timeout, execution) =>
      (controlled = createHostTerminal(command, timeout, execution, {
        signal: abort.signal,
        valid: () => true,
      })),
  });
  return {
    manager,
    opened,
    terminal: () => terminal,
    controlled: () => controlled,
    approvals: () => approvals,
  };
}

async function productionCase(home: string, scenario: 'success' | 'failure' | 'early') {
  await vscode.commands.executeCommand('workbench.action.closePanel');
  const abort = new AbortController();
  const fixture = productionManager(home, abort);
  const { manager, opened } = fixture;
  try {
    const expected = `SYNTHETIC_${randomUUID()}`;
    const value = scenario === 'failure' ? `SYNTHETIC_${randomUUID()}` : expected;
    const expectedPath = path.join(home, `expected-production-${scenario}`);
    await writeFile(expectedPath, expected, { mode: 0o600 });
    const handle = await startCommand(manager, home, expectedPath, abort.signal);
    const request = { sessionId: 'production-fixture', ...handle };
    assert.equal((await manager.waitForOutput(request, 3000)).output, 'READY');
    assert.ok(fixture.terminal());
    const prefix = path.join(home, `keyboard-production-${scenario}`);
    await writeFile(`${prefix}-background-ready`, 'ready', { mode: 0o600 });
    await fileSignal(`${prefix}-background-checked`);
    let completed = 0;
    const completion = manager.waitForExit(request).then(() => {
      completed++;
    });
    void completion.catch(() => {});
    let returned = 0;
    const hold = manager.takeover(request).then(() => {
      returned++;
    });
    void hold.catch(() => {});
    const confirmed = scenario === 'early' ? fileSignal(`${prefix}-confirmed`) : undefined;
    await writeFile(
      `${prefix}-ready.json`,
      JSON.stringify({
        value,
        button: 'Resume Agent',
        terminal: fixture.terminal()!.name.split(':')[0],
      }),
      { mode: 0o600 },
    );
    if (confirmed) {
      await confirmed;
      assert.equal(returned, 0);
      assert.equal(manager.output(request).exitStatus, undefined);
    }
    const status = await bounded(fixture.controlled()!.done);
    assert.equal(status.exitCode, scenario === 'failure' ? 1 : 0);
    assert.equal(manager.output(request).output, '');
    assert.equal(manager.output(request)._meta?.['vs-omp/capture'], 'withheld-after-takeover');
    if (scenario !== 'early') {
      assert.equal(returned, 0);
      assert.equal(completed, 0);
    }
    await writeFile(`${prefix}-finished`, 'finished', { mode: 0o600 });
    await bounded(hold);
    await bounded(completion);
    assert.equal(returned, 1);
    assert.equal(completed, 1);
    assert.equal(fixture.approvals(), 1);
    assert.equal(manager.output(request).output.includes(value), false);
    await manager.release(request);
    assert.throws(() => manager.reveal(request), /released/);
    return {
      scenario,
      exitCode: status.exitCode,
      confirmations: 1,
      continuations: returned,
      productionAdapter: true,
      modelCaptureWithheld: true,
    };
  } finally {
    abort.abort();
    opened.dispose();
    await manager.dispose();
  }
}

async function negativeCase(
  home: string,
  action: 'cancel' | 'dismiss' | 'stop' | 'close' | 'abort' | 'stale',
) {
  const abort = new AbortController();
  let valid = true;
  let owned: vscode.Terminal | undefined;
  const opened = vscode.window.onDidOpenTerminal((candidate) => {
    if (/^OMP [a-f0-9]{8}$/.test(candidate.name)) owned = candidate;
  });
  const controlWrites = new vscode.EventEmitter<string>();
  let controlClosed = false;
  const control = vscode.window.createTerminal({
    name: 'OMP unrelated terminal control',
    isTransient: true,
    pty: {
      onDidWrite: controlWrites.event,
      open() {},
      close() {
        controlClosed = true;
      },
    },
  });
  const manager = new TerminalManager({
    sessionId: 'production-fixture',
    cwd: home,
    signal: abort.signal,
    approve: async () => true,
    launch: (command, timeout, execution) =>
      createHostTerminal(command, timeout, execution, { signal: abort.signal, valid: () => valid }),
  });
  try {
    const handle = await startCommand(manager, home, path.join(home, 'unused'), abort.signal);
    const request = { sessionId: 'production-fixture', ...handle };
    assert.equal((await manager.waitForOutput(request, 3000)).output, 'READY');
    assert.ok(owned);
    const hold = manager.takeover(request);
    void hold.catch(() => {});
    await assert.rejects(manager.takeover(request), /already pending/);
    if (action === 'stop') await manager.kill(request);
    else if (action === 'close') owned.dispose();
    else if (action === 'abort') abort.abort();
    else if (action === 'cancel' || action === 'dismiss')
      await writeFile(
        path.join(home, `production-${action}-ready.json`),
        JSON.stringify({ terminal: owned.name.split(':')[0] }),
        { mode: 0o600 },
      );
    else {
      valid = false;
      owned.sendText('blocked-stale-input', false);
    }
    await bounded(assert.rejects(hold, /cancelled|stale/));
    await assert.rejects(manager.waitForExit(request));
    assert.equal(controlClosed, false);
    return { action, holdRejected: true, controlSurvived: true, productionAdapter: true };
  } finally {
    abort.abort();
    opened.dispose();
    await manager.dispose();
    control.dispose();
    controlWrites.dispose();
  }
}

async function assertPrivateTranscript(home: string, value: string, exitCode: number) {
  const context = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  assert.equal(context.includes(value), false);
  const state = JSON.parse(context);
  const results = state.messages.filter(
    (message: { role: string }) => message.role === 'toolResult',
  );
  assert.equal(results.length, 5);
  assert.match(JSON.stringify(results[1]), /OTHER_SAFE_WORK/);
  for (const index of [2, 3]) {
    const result = JSON.parse(
      results[index].content.find((block: { type: string }) => block.type === 'text').text,
    );
    assert.equal(result.output, '');
    assert.equal(result._meta['vs-omp/capture'], 'withheld-after-takeover');
    assert.equal(result.exitStatus.exitCode, exitCode);
    assert.equal(results[index].isError ?? false, exitCode !== 0);
  }
  const directory = path.join(home, '.native-private', 'sessions');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0);
  assert.equal(typeof results[0].toolCallId, 'string');
  let persisted = false;
  for (const name of names) {
    const text = await readFile(path.join(directory, name), 'utf8');
    assert.equal(text.includes(value), false);
    persisted ||= text.includes(results[0].toolCallId);
  }
  assert.ok(persisted, 'The actual tool call must exist in the checked native transcripts.');
  return results;
}

function observeTakeover() {
  const original = TerminalManager.prototype.takeover;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let owned: vscode.Terminal | undefined;
  const opened = vscode.window.onDidOpenTerminal((candidate) => {
    if (/^OMP [a-f0-9]{8}$/.test(candidate.name)) owned = candidate;
  });
  TerminalManager.prototype.takeover = function (request) {
    const result = original.call(this, request);
    entered();
    return result;
  };
  return {
    async wait(execution: Promise<unknown>) {
      await bounded(
        Promise.race([
          held,
          execution.then(() => {
            throw new Error('No takeover hold.');
          }),
        ]),
      );
      assert.ok(owned);
      return owned;
    },
    dispose() {
      opened.dispose();
      TerminalManager.prototype.takeover = original;
    },
  };
}

function handoffTools(home: string) {
  const files = new WorkspaceFiles(vscode.Uri.file(home));
  const journal = new ReviewJournal(
    files,
    new PathGuard([home]),
    async () => false,
    async () => {},
  );
  let approvals = 0;
  const tools = new HostTools(
    files,
    journal,
    path.join(home, '.native-private', 'mutations'),
    async () => {
      approvals++;
      return true;
    },
  );
  return { tools, approvals: () => approvals };
}

async function installedCase(home: string, failed: boolean) {
  const scenario = failed ? 'failure' : 'success';
  const prefix = path.join(home, `keyboard-installed-${scenario}`);
  const expectedPath = `${prefix}-expected`;
  const expected = `SYNTHETIC_${randomUUID()}`;
  const value = failed ? `SYNTHETIC_${randomUUID()}` : expected;
  await writeFile(expectedPath, expected, { mode: 0o600 });
  const previous = process.env.VS_OMP_FIXTURE_HANDOFF;
  process.env.VS_OMP_FIXTURE_HANDOFF = JSON.stringify({
    command: `printf READY; IFS= read -rs value; printf '%s' "$value"; test "$value" = "$(cat ${JSON.stringify(expectedPath)})"; status=$?; printf finished > ${JSON.stringify(`${prefix}-process-finished`)}; exit "$status"`,
  });
  const abort = new AbortController();
  const fixture = handoffTools(home);
  const { tools } = fixture;
  const session = await nativeSession(
    tools,
    home,
    'handoff',
    abort,
    undefined,
    'terminal-handoff-fixture.mjs',
  );
  const observation = observeTakeover();
  try {
    const execution = tools.run(
      {
        sessionId: session.client.sessionId!,
        owner: 'handoff',
        cwd: home,
        signal: abort.signal,
        valid: () => true,
      },
      () => session.client.prompt(promptBlocks('PTY_HANDOFF_FIXTURE')),
    );
    void execution.catch(() => {});
    const owned = await observation.wait(execution);
    const before = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
    assert.equal(JSON.parse(before).fixtureReply[0].arguments.action, 'takeover');
    await writeFile(
      `${prefix}-ready.json`,
      JSON.stringify({ value, button: 'Resume Agent', terminal: owned.name.split(':')[0] }),
      { mode: 0o600 },
    );
    await fileSignal(`${prefix}-process-finished`);
    assert.equal(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'), before);
    await writeFile(`${prefix}-finished`, 'finished', { mode: 0o600 });
    await bounded(execution);
    const results = await assertPrivateTranscript(home, value, failed ? 1 : 0);
    assert.equal(fixture.approvals(), 2);
    return {
      installedOmp: true,
      scenario,
      toolResults: results.length,
      providerHeld: true,
      privateTranscript: true,
    };
  } finally {
    abort.abort();
    observation.dispose();
    if (previous === undefined) delete process.env.VS_OMP_FIXTURE_HANDOFF;
    else process.env.VS_OMP_FIXTURE_HANDOFF = previous;
    try {
      await session.client.stop();
    } finally {
      await tools.finish();
    }
  }
}

export async function productionTerminals(home: string) {
  const checks = [];
  for (const scenario of ['success', 'failure', 'early'] as const)
    checks.push(await productionCase(home, scenario));
  for (const failed of [false, true]) checks.push(await installedCase(home, failed));
  for (const action of ['cancel', 'dismiss', 'stop', 'close', 'abort', 'stale'] as const)
    checks.push(await negativeCase(home, action));
  console.log('PASS: production PTY keyboard takeover, failed outcome and early Resume hold.');
  console.log(
    'PASS: installed OMP scripted hand-off preserves provider silence and private transcripts.',
  );
  return checks;
}
