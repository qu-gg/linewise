import type { TerminalExitStatus, TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { environment } from './terminal.js';
import type { ManagedTerminal, TerminalCommand } from './terminal.js';

export class PtyTerminal implements ManagedTerminal {
  private readonly child: IPty;
  private readonly changes = new EventEmitter();
  private readonly outputObservers = new Set<(snapshot: TerminalOutputResponse) => void>();
  private output = '';
  private truncated = false;
  private suppressed = false;
  private human = false;
  private status: TerminalExitStatus | undefined;
  private termination: string | undefined;
  private cleanupError: unknown;
  private readonly deadline: NodeJS.Timeout | undefined;
  private escalation: NodeJS.Timeout | undefined;
  readonly ready = Promise.resolve();
  readonly done: Promise<TerminalExitStatus>;

  constructor(
    private readonly command: TerminalCommand,
    timeoutMs: number | null,
    write: (text: string) => void,
  ) {
    this.child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: environment(command.env, command.cwd),
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
    this.child.onData((text) => {
      this.append(text);
      write(text);
      this.notify();
      this.changes.emit('change');
    });
    this.deadline =
      timeoutMs === null ? undefined : setTimeout(() => this.terminate('timeout'), timeoutMs);
    this.done = new Promise((resolve) => {
      this.child.onExit(({ exitCode, signal }) => {
        clearTimeout(this.deadline);
        clearTimeout(this.escalation);
        this.human = false;
        this.signalGroup('SIGKILL');
        this.status = {
          exitCode: signal ? null : exitCode,
          signal: signal
            ? (Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ??
              `signal-${signal}`)
            : null,
        };
        if (this.termination) this.status._meta = { 'vs-omp/termination': this.termination };
        this.notify();
        this.changes.emit('change');
        resolve(structuredClone(this.status));
      });
    });
  }

  private append(text: string): void {
    if (this.suppressed) return;
    const bytes = Buffer.from(this.output + text);
    let start = Math.max(0, bytes.length - this.command.outputByteLimit);
    this.truncated ||= start > 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.output = bytes.toString('utf8', start);
  }

  private notify(): void {
    if (!this.outputObservers.size) return;
    let snapshot: TerminalOutputResponse;
    try {
      snapshot = this.snapshot();
    } catch {
      return;
    }
    for (const observer of this.outputObservers) {
      try {
        observer(snapshot);
      } catch {
        // Stream observers are presentation-only; they cannot change execution.
      }
    }
  }

  observeOutput(listener: (snapshot: TerminalOutputResponse) => void): () => void {
    this.outputObservers.add(listener);
    this.notify();
    return () => {
      this.outputObservers.delete(listener);
    };
  }

  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      this.cleanupError = error;
      this.child.kill('SIGKILL');
    }
  }

  terminate(reason: string): void {
    if (this.status || this.termination) return;
    this.human = false;
    this.termination = reason;
    this.signalGroup('SIGTERM');
    this.escalation = setTimeout(() => this.signalGroup('SIGKILL'), 100);
  }

  beginTakeover(): void {
    if (this.status || this.termination || this.human)
      throw new Error('Terminal is not available for takeover.');
    this.suppressed = true;
    this.output = '';
    this.human = true;
    this.outputObservers.clear();
  }

  endTakeover(): void {
    this.human = false;
  }

  input(data: string): boolean {
    if (this.status || this.termination) return false;
    if (!this.human && data !== '\x03') return false;
    this.child.write(data);
    return true;
  }

  resize(columns: number, rows: number): void {
    if (this.status || this.termination) return;
    if (![columns, rows].every((value) => Number.isInteger(value) && value > 0 && value <= 1000))
      throw new Error('Invalid terminal dimensions.');
    this.child.resize(columns, rows);
  }

  snapshot(): TerminalOutputResponse {
    this.assertCleanup();
    return {
      output: this.output,
      truncated: this.truncated,
      exitStatus: this.status && structuredClone(this.status),
      ...(this.suppressed ? { _meta: { 'vs-omp/capture': 'withheld-after-takeover' } } : {}),
    };
  }

  async waitForOutput(waitMs: number): Promise<TerminalOutputResponse> {
    const current = this.snapshot();
    if (current.output || current.exitStatus || !waitMs) return current;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.changes.removeListener('change', finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.changes.once('change', finish);
    });
    return this.snapshot();
  }

  assertCleanup(): void {
    if (this.cleanupError)
      throw new Error('Terminal process-group cleanup failed.', { cause: this.cleanupError });
  }
}
