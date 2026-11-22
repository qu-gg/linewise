import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { TerminalExitStatus, TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { RunningTerminal, TerminalManager } from './terminal.js';
import type {
  ManagedTerminal,
  TerminalCommand,
  TerminalExecution,
  TerminalOptions,
} from './terminal.js';
import { PtyTerminal } from './terminal-pty.js';

interface TerminalScope {
  signal: AbortSignal;
  valid(): boolean;
}

class HostTerminal implements ManagedTerminal, vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  private readonly names = new vscode.EventEmitter<string>();
  private readonly stopped = new AbortController();
  readonly onDidWrite = this.writes.event;
  readonly onDidChangeName = this.names.event;
  private readonly terminal: vscode.Terminal;
  private readonly name = `OMP ${randomUUID().slice(0, 8)}`;
  readonly label = this.name;
  private backend: PtyTerminal | RunningTerminal | undefined;
  private closed = false;
  private human = false;
  private displayBytes = 0;
  private handback: Promise<void> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private resolveDone!: (status: TerminalExitStatus) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  readonly done = new Promise<TerminalExitStatus>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    private readonly command: TerminalCommand,
    private readonly timeoutMs: number | null,
    private readonly execution: TerminalExecution,
    private readonly scope: TerminalScope,
  ) {
    scope.signal.throwIfAborted();
    if (!this.current()) throw new Error('Terminal scope is stale.');
    void this.ready.catch(() => {});
    this.terminal = vscode.window.createTerminal({ name: this.name, pty: this, isTransient: true });
    if (execution.visibility === 'foreground') this.terminal.show(false);
  }

  private current(): boolean {
    try {
      return !this.closed && !this.scope.signal.aborted && this.scope.valid();
    } catch {
      return false;
    }
  }

  get interactive(): boolean {
    return this.execution.pty;
  }

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    if (this.closed || this.backend) return;
    try {
      if (!this.current()) throw new Error('Terminal scope is stale.');
      const write = (text: string) => {
        const display = text.replace(/\r?\n/g, '\r\n');
        this.displayBytes += Buffer.byteLength(display, 'utf8');
        if (this.displayBytes > 1024 * 1024) this.backend?.terminate('terminal-output-limit');
        else this.writes.fire(display);
      };
      this.backend = this.execution.pty
        ? new PtyTerminal(this.command, this.timeoutMs, write)
        : new RunningTerminal(this.command, this.timeoutMs, write);
      if (dimensions) this.setDimensions(dimensions);
      void this.backend.ready.then(this.resolveReady, this.rejectReady);
      void this.backend.done.then((status) => {
        this.names.fire(`${this.name}: Exited`);
        this.resolveDone(status);
      });
    } catch (error) {
      this.backend?.terminate('startup-failure');
      this.rejectReady(error);
      if (this.backend) void this.backend.done.then(this.resolveDone);
      else this.resolveDone({ exitCode: null, signal: null });
    }
  }

  close(): void {
    this.terminate('terminal-closed');
  }

  terminate(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopped.abort(new Error('Terminal was stopped or closed.'));
    this.backend?.terminate(reason);
    if (!this.backend) {
      this.rejectReady(new Error('Terminal closed before startup.'));
      this.resolveDone({ exitCode: null, signal: null, _meta: { 'vs-omp/termination': reason } });
    }
    this.terminal?.dispose();
    this.writes.dispose();
    this.names.dispose();
  }

  handleInput(data: string): void {
    if (!this.current()) {
      this.terminate('stale-input');
      return;
    }
    this.backend?.input(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.backend instanceof PtyTerminal)
      this.backend.resize(dimensions.columns, dimensions.rows);
  }

  reveal(): void {
    if (!this.current()) throw new Error('Terminal scope is stale.');
    this.terminal.show(false);
  }

  takeover(): Promise<void> {
    if (this.handback) return Promise.reject(new Error('Terminal takeover is already pending.'));
    if (!this.current() || this.human || !(this.backend instanceof PtyTerminal))
      return Promise.reject(new Error('This terminal is not available for takeover.'));
    try {
      this.backend.beginTakeover();
    } catch (error) {
      return Promise.reject(error);
    }
    this.human = true;
    const pending = this.performTakeover(this.backend);
    this.handback = pending;
    void pending.catch(() => {});
    return pending;
  }

  waitForHandback(): Promise<void> {
    return this.handback ?? Promise.resolve();
  }

  private async confirmTakeover(active: () => boolean): Promise<void> {
    this.names.fire(`${this.name}: Waiting for User`);
    this.reveal();
    const choice = await vscode.window.showInformationMessage(
      `${this.name}: Waiting for User`,
      'Resume Agent',
      'Cancel Command',
    );
    if (!active() || !this.current()) throw new Error('Terminal takeover is stale.');
    if (choice !== 'Resume Agent') throw new Error('Terminal takeover was cancelled.');
  }

  private async performTakeover(backend: PtyTerminal): Promise<void> {
    let active = true;
    let abort!: () => void;
    const signal = AbortSignal.any([this.scope.signal, this.stopped.signal]);
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Terminal takeover was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      await Promise.race([
        Promise.all([this.confirmTakeover(() => active), this.done]),
        interrupted,
      ]);
      if (!this.current()) throw new Error('Terminal takeover is stale.');
      this.assertCleanup();
    } catch (error) {
      backend.terminate('takeover-cancelled');
      await this.done;
      throw error;
    } finally {
      active = false;
      signal.removeEventListener('abort', abort);
      backend.endTakeover();
      this.human = false;
    }
  }

  snapshot(): TerminalOutputResponse {
    return this.backend?.snapshot() ?? { output: '', truncated: false };
  }

  async waitForOutput(waitMs: number): Promise<TerminalOutputResponse> {
    await this.ready;
    return this.backend!.waitForOutput(waitMs);
  }

  assertCleanup(): void {
    this.backend?.assertCleanup();
  }
}

export function createHostTerminal(
  command: TerminalCommand,
  timeoutMs: number | null,
  execution: TerminalExecution,
  scope: TerminalScope,
): ManagedTerminal | undefined {
  if (!execution.pty && execution.visibility === 'hidden') return;
  return new HostTerminal(command, timeoutMs, execution, scope);
}

export function createTerminalManager(
  scope: Pick<TerminalOptions, 'sessionId' | 'cwd' | 'signal'>,
  approve: TerminalOptions['approve'],
  valid: () => void,
): TerminalManager {
  return new TerminalManager({
    ...scope,
    approve,
    launch: (command, timeout, execution) =>
      createHostTerminal(command, timeout, execution, {
        signal: scope.signal,
        valid: () => {
          valid();
          return true;
        },
      }),
  });
}

async function chooseOwnedTerminal(
  manager: TerminalManager,
  sessionId: string,
  valid: () => void,
  token: vscode.CancellationToken,
) {
  valid();
  const choices = manager.choices().filter((choice) => choice.visible);
  if (!choices.length) throw new Error('No integrated terminal belongs to the active prompt.');
  const chosen = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      ...choice,
      description: choice.running ? 'Running' : 'Exited',
    })),
    { title: 'OMP Terminals', placeHolder: 'Active prompt terminals' },
    token,
  );
  valid();
  if (!chosen) return true;
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Reveal', value: 'reveal' },
      ...(chosen.running && chosen.interactive ? [{ label: 'Take Over', value: 'takeover' }] : []),
      { label: 'Stop', value: 'stop' },
    ],
    { title: chosen.label },
    token,
  );
  valid();
  const request = { sessionId, terminalId: chosen.terminalId };
  const operation = action?.value;
  if (operation === 'reveal') manager.reveal(request);
  else if (operation === 'takeover') await manager.takeover(request);
  else if (operation === 'stop') await manager.kill(request);
  return !action;
}

export async function pickOwnedTerminal(
  manager: TerminalManager,
  sessionId: string,
  valid: () => void,
  signal = new AbortController().signal,
  onCancel?: () => void,
): Promise<void> {
  signal.throwIfAborted();
  const source = new vscode.CancellationTokenSource();
  const cancel = () => source.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const cancelled = await chooseOwnedTerminal(manager, sessionId, valid, source.token);
    signal.throwIfAborted();
    if (cancelled) {
      valid();
      onCancel?.();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    source.dispose();
  }
}
