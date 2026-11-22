import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { productionTerminals } from './production-terminal.integration.js';

function bounded<Value>(pending: PromiseLike<Value>, label: string): Promise<Value> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(pending),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Probe deadline: ${label}`)), 20000);
    }),
  ]).finally(() => clearTimeout(timer));
}

class Executions implements vscode.Disposable {
  readonly owned = new Set<vscode.Terminal>();
  readonly outcomes = new Map<vscode.TerminalShellExecution, number | undefined>();
  readonly counts = new Map<vscode.TerminalShellExecution, number>();
  waitCalls = 0;
  private readonly waiters = new Map<
    vscode.TerminalShellExecution,
    (code: number | undefined) => void
  >();
  private readonly ended = vscode.window.onDidEndTerminalShellExecution((event) => {
    if (!this.owned.has(event.terminal)) return;
    this.outcomes.set(event.execution, event.exitCode);
    this.counts.set(event.execution, (this.counts.get(event.execution) ?? 0) + 1);
    this.waiters.get(event.execution)?.(event.exitCode);
    this.waiters.delete(event.execution);
  });

  wait(execution: vscode.TerminalShellExecution): Promise<number | undefined> {
    this.waitCalls++;
    if (this.outcomes.has(execution)) return Promise.resolve(this.outcomes.get(execution));
    assert.equal(this.waiters.has(execution), false);
    return bounded(
      new Promise<number | undefined>((resolve) => this.waiters.set(execution, resolve)),
      'execution completion',
    );
  }

  dispose(): void {
    this.ended.dispose();
    for (const terminal of this.owned) terminal.dispose();
    this.waiters.clear();
  }
}

async function integration(
  terminal: vscode.Terminal,
  signal?: AbortSignal,
): Promise<vscode.TerminalShellIntegration> {
  if (signal?.aborted) throw new Error('Shell integration wait cancelled.');
  if (terminal.shellIntegration) return terminal.shellIntegration;
  let subscription: vscode.Disposable | undefined;
  let closed: vscode.Disposable | undefined;
  let abort: (() => void) | undefined;
  try {
    return await bounded(
      new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
        subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
          if (event.terminal === terminal) resolve(event.shellIntegration);
        });
        closed = vscode.window.onDidCloseTerminal((candidate) => {
          if (candidate === terminal) reject(new Error('Terminal closed before integration.'));
        });
        abort = () => reject(new Error('Shell integration wait cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        if (terminal.exitStatus) reject(new Error('Terminal closed before integration.'));
        if (terminal.shellIntegration) resolve(terminal.shellIntegration);
      }),
      'shell integration activation',
    );
  } finally {
    subscription?.dispose();
    closed?.dispose();
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

async function unavailable(events: Executions) {
  const writes = new vscode.EventEmitter<string>();
  let open!: () => void;
  const ready = new Promise<void>((resolve) => (open = resolve));
  let inputs = 0;
  const terminal = vscode.window.createTerminal({
    name: 'OMP T-04 disposable no-integration fixture',
    pty: {
      onDidWrite: writes.event,
      open,
      close() {},
      handleInput() {
        inputs++;
      },
    },
  });
  events.owned.add(terminal);
  try {
    await bounded(ready, 'no-integration terminal open');
    assert.equal(terminal.shellIntegration, undefined);
    const controller = new AbortController();
    const cancelled = assert.rejects(integration(terminal, controller.signal), /wait cancelled/);
    controller.abort();
    await cancelled;
    await assert.rejects(integration(terminal, controller.signal), /wait cancelled/);
    const closed = assert.rejects(integration(terminal), /closed before integration/);
    terminal.dispose();
    await closed;
    assert.equal(inputs, 0);
    events.owned.delete(terminal);
    return {
      fixtureIntegrationAbsent: true,
      cancellation: true,
      close: true,
      fallbackInput: false,
    };
  } finally {
    writes.dispose();
  }
}

class Capture {
  text = '';
  suppressedBytes = 0;
  private receivedBytes = 0;
  private visible = true;
  private readonly markers = new Map<string, () => void>();
  private cancelRead!: () => void;
  private readonly cancelled = new Promise<IteratorResult<string>>((resolve) => {
    this.cancelRead = () => resolve({ done: true, value: undefined });
  });
  readonly done: Promise<void>;

  constructor(execution: vscode.TerminalShellExecution) {
    this.done = this.read(execution);
    void this.done.catch(() => {});
  }

  private async read(execution: vscode.TerminalShellExecution): Promise<void> {
    const stream = execution.read()[Symbol.asyncIterator]();
    for (;;) {
      const chunk = await Promise.race([stream.next(), this.cancelled]);
      if (chunk.done) return;
      const bytes = Buffer.byteLength(chunk.value);
      this.receivedBytes += bytes;
      assert.ok(this.receivedBytes <= 65536, 'Probe output must remain bounded.');
      if (!this.visible) {
        this.suppressedBytes += bytes;
        continue;
      }
      this.text += chunk.value;
      for (const [marker, resolve] of this.markers)
        if (this.text.includes(marker)) {
          this.markers.delete(marker);
          resolve();
        }
    }
  }

  until(marker: string): Promise<void> {
    assert.ok(this.visible, 'Reads are disabled for the sensitive execution.');
    if (this.text.includes(marker)) return Promise.resolve();
    return bounded(
      new Promise<void>((resolve) => this.markers.set(marker, resolve)),
      'output marker',
    );
  }

  cancel(): void {
    this.cancelRead();
    this.markers.clear();
  }

  suppress(): void {
    this.visible = false;
    this.markers.clear();
  }
}

async function command(events: Executions, shell: vscode.TerminalShellIntegration, text: string) {
  const execution = shell.executeCommand(text);
  const capture = new Capture(execution);
  const [code] = await bounded(
    Promise.all([events.wait(execution), capture.done]),
    'execution output drain',
  );
  assert.equal(events.counts.get(execution), 1);
  return { execution, code, captured: capture.text };
}

function create(events: Executions, home: string, name: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: `OMP T-04 disposable ${name}`,
    shellPath: '/bin/bash',
    shellArgs: [],
    cwd: home,
    strictEnv: true,
    env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/bash', HISTFILE: '/dev/null' },
  });
  events.owned.add(terminal);
  return terminal;
}

async function revealed(terminal: vscode.Terminal): Promise<void> {
  let subscription: vscode.Disposable | undefined;
  try {
    await bounded(
      new Promise<void>((resolve) => {
        subscription = vscode.window.onDidChangeActiveTerminal((active) => {
          if (active === terminal) resolve();
        });
        terminal.show(false);
        if (vscode.window.activeTerminal === terminal) resolve();
      }),
      'terminal reveal',
    );
    assert.equal(vscode.window.activeTerminal, terminal);
  } finally {
    subscription?.dispose();
  }
}

async function interaction(events: Executions, terminal: vscode.Terminal) {
  await revealed(terminal);
  const shell = await integration(terminal);
  const marker = randomUUID();
  const execution = shell.executeCommand(
    `printf 'READY_%s\\n' '${marker}'; IFS= read -rs probe_value; ` +
      'printf "\\nINPUT_LENGTH_%s\\n" "${#probe_value}"; unset probe_value',
  );
  const capture = new Capture(execution);
  await capture.until(`READY_${marker}`);
  const document = await vscode.workspace.openTextDocument({
    content: 'other safe work during job',
  });
  assert.equal(document.getText(), 'other safe work during job');
  assert.equal(events.outcomes.has(execution), false);
  const before = events.waitCalls;
  const completion = events.wait(execution);
  const fixtureInput = randomUUID();
  terminal.sendText(fixtureInput, true);
  assert.equal(await completion, 0);
  await bounded(capture.done, 'interactive output drain');
  assert.ok(capture.text.includes(`INPUT_LENGTH_${fixtureInput.length}`));
  assert.equal(capture.text.includes(fixtureInput), false);
  assert.equal(events.waitCalls - before, 1);
  assert.equal(events.counts.get(execution), 1);
  return {
    reveal: true,
    programmaticNonEchoInput: true,
    otherWorkBeforeSingleHold: true,
    manualKeyboardAndCapturePauseCertified: false,
  };
}

type KeyboardScenario = 'success' | 'failure' | 'early';

async function keyboardHold(
  events: Executions,
  execution: vscode.TerminalShellExecution,
  capture: Capture,
  scenario: KeyboardScenario,
  value: string,
) {
  const home = process.env.VS_OMP_TERMINAL_PROBE_HOME!;
  const button = `Resume fixture ${randomUUID().slice(0, 8)}`;
  const confirmation = vscode.window.showInformationMessage(
    'OMP terminal takeover fixture',
    button,
  );
  const completion = events.wait(execution);
  let continuations = 0;
  const pending = Promise.all([completion, capture.done, confirmation]).then(([code, , choice]) => {
    assert.equal(choice, button);
    continuations++;
    return code;
  });
  void pending.catch(() => {});
  await writeFile(`${home}/keyboard-${scenario}-ready.json`, JSON.stringify({ value, button }), {
    mode: 0o600,
  });
  if (scenario === 'early') {
    await bounded(Promise.resolve(confirmation), 'early fixture confirmation');
    assert.equal(events.outcomes.has(execution), false);
    assert.equal(continuations, 0);
    await writeFile(`${home}/keyboard-${scenario}-confirmed`, 'pending');
  }
  const code = await completion;
  await bounded(capture.done, 'suppressed output drain');
  if (scenario !== 'early') {
    assert.equal(continuations, 0);
    await writeFile(`${home}/keyboard-${scenario}-finished`, 'finished');
  }
  assert.equal(await bounded(pending, 'explicit fixture resume'), code);
  assert.equal(continuations, 1);
  return code;
}

async function sensitiveInput(
  events: Executions,
  terminal: vscode.Terminal,
  scenario: KeyboardScenario,
) {
  await revealed(terminal);
  const shell = await integration(terminal);
  const marker = randomUUID();
  const expected = `FAKE_${randomUUID()}`;
  const target = `${process.env.VS_OMP_TERMINAL_PROBE_HOME}/mock-auth-expected`;
  await writeFile(target, expected, { mode: 0o600 });
  const execution = shell.executeCommand(
    `printf 'TAKEOVER_%s\\n' '${marker}'; IFS= read -rs probe_value; ` +
      'printf "\\n%s\\n" "$probe_value"; ' +
      `if [[ "$probe_value" == "$(<${JSON.stringify(target)})" ]]; then probe_status=0; else probe_status=7; fi; ` +
      'unset probe_value; (exit "$probe_status")',
  );
  const capture = new Capture(execution);
  await capture.until(`TAKEOVER_${marker}`);
  capture.suppress();
  const fakeEcho = scenario === 'failure' ? `WRONG_${randomUUID()}` : expected;
  assert.throws(() => capture.until(fakeEcho), /Reads are disabled/);
  const code = await keyboardHold(events, execution, capture, scenario, fakeEcho);
  assert.equal(code, scenario === 'failure' ? 7 : 0);
  assert.ok(capture.suppressedBytes >= Buffer.byteLength(fakeEcho));
  assert.equal(capture.text.includes(fakeEcho), false);
  assert.equal(capture.text.includes(expected), false);
  const fresh = await command(events, shell, `printf 'FRESH_%s\\n' '${marker}'`);
  assert.equal(fresh.code, 0);
  assert.ok(fresh.captured.includes(`FRESH_${marker}`));
  assert.equal(fresh.captured.includes(fakeEcho), false);
  return {
    scenario,
    exitCode: code,
    explicitResumeRequired: true,
    singleContinuation: true,
    workbenchKeyboardFakeEchoSuppressed: true,
    sensitiveExecutionPermanentlyUnreadable: true,
    freshExecutionAfterCompletion: true,
    terminalScrollbackErased: false,
    productionTakeoverCertified: false,
  };
}

async function interrupted(events: Executions, terminal: vscode.Terminal) {
  const shell = await integration(terminal);
  const marker = randomUUID();
  const execution = shell.executeCommand(`printf 'WAIT_%s\\n' '${marker}'; read -r probe_value`);
  const capture = new Capture(execution);
  await capture.until(`WAIT_${marker}`);
  const completion = events.wait(execution);
  terminal.sendText('\u0003', false);
  const code = await completion;
  assert.notEqual(code, 0);
  await bounded(capture.done, 'interrupted output drain');
  assert.equal((await command(events, shell, 'true')).code, 0);
  return { code: code ?? 'unknown', interruptedAndRecovered: true };
}

async function closed(events: Executions, terminal: vscode.Terminal) {
  const shell = await integration(terminal);
  const marker = randomUUID();
  const execution = shell.executeCommand(`printf 'CLOSE_%s\\n' '${marker}'; read -r probe_value`);
  const capture = new Capture(execution);
  await capture.until(`CLOSE_${marker}`);
  let subscription: vscode.Disposable | undefined;
  try {
    await bounded(
      new Promise<void>((resolve) => {
        subscription = vscode.window.onDidCloseTerminal((candidate) => {
          if (candidate === terminal) {
            capture.cancel();
            resolve();
          }
        });
        terminal.dispose();
      }),
      'terminal close',
    );
    await bounded(capture.done, 'closed output drain');
    events.owned.delete(terminal);
    return {
      closeEvent: true,
      shellEndEvent: events.outcomes.has(execution),
      outputReaderCancelledOnClose: true,
      rawStreamEndOnCloseCertified: false,
    };
  } finally {
    subscription?.dispose();
  }
}

async function basics(events: Executions, home: string) {
  const document = await vscode.workspace.openTextDocument({ content: 'preserve probe editor' });
  await vscode.window.showTextDocument(document);
  const terminal = create(events, home, 'execution');
  const shell = await integration(terminal);
  assert.equal(vscode.window.activeTextEditor?.document, document);
  const marker = randomUUID();
  const first = await command(events, shell, `printf 'PROBE_%s\\n' '${marker}'`);
  assert.equal(first.code, 0);
  assert.ok(first.captured.includes(`PROBE_${marker}`));
  const failed = await command(events, shell, 'printf "probe failure\\n"; (exit 7)');
  assert.equal(failed.code, 7);
  const fast = await command(events, shell, 'true');
  assert.equal(await events.wait(fast.execution), 0);
  return terminal;
}

export async function run(): Promise<void> {
  const home = process.env.VS_OMP_TERMINAL_PROBE_HOME!;
  const report = process.env.VS_OMP_TERMINAL_PROBE_REPORT!;
  assert.ok(home && report);
  assert.equal(vscode.extensions.getExtension('vs-omp-local.vs-omp'), undefined);
  const checks: Record<string, unknown> = {
    native: true,
    inference: false,
    productionExtensionActivated: false,
    productionAdaptersLoaded: true,
    installedOmpScriptedProvider: true,
  };
  const events = new Executions();
  try {
    checks.unavailableIntegration = await unavailable(events);
    const terminal = await basics(events, home);
    checks.backgroundOutputFailureAndLateHold = true;
    const control = create(events, home, 'control');
    const controlShell = await integration(control);
    assert.equal((await command(events, controlShell, 'true')).code, 0);
    checks.interaction = await interaction(events, terminal);
    const takeover = [];
    for (const scenario of ['success', 'failure', 'early'] as const)
      takeover.push(await sensitiveInput(events, terminal, scenario));
    checks.keyboardTakeover = takeover;
    checks.interrupt = await interrupted(events, terminal);
    checks.close = await closed(events, terminal);
    assert.equal((await command(events, controlShell, 'true')).code, 0);
    checks.separateFixtureControlSurvives = true;
    checks.executionEvents = events.outcomes.size;
    checks.productionTerminal = await productionTerminals(home);
    checks.passed = true;
    console.log(
      'PASS: native shell events, late/single holds, input, Ctrl+C, close and control isolation.',
    );
  } catch (error) {
    checks.passed = false;
    checks.error = String(error);
    throw error;
  } finally {
    events.dispose();
    await writeFile(report, JSON.stringify(checks, null, 2), { mode: 0o600 });
  }
}
