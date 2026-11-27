import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
} from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { reserveCommands } from './terminal-reservation.js';
import type { TerminalCommand, ReservedTerminals } from './terminal-reservation.js';
export type { TerminalCommand, ReservedTerminals } from './terminal-reservation.js';

const text = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'));
const requestSchema = z
  .object({
    sessionId: z.string().min(1),
    command: text.min(1),
    args: z.array(text).max(256).default([]),
    cwd: text.nullish(),
    env: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: text }))
      .max(64)
      .default([]),
    outputByteLimit: z.number().int().min(0).max(1_048_576).nullish(),
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536,
    'Terminal request is too large.',
  );

export interface TerminalOptions {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  approve(command: Readonly<TerminalCommand>, signal: AbortSignal): Promise<boolean>;
  timeoutMs?: number | null;
  launch?(
    command: TerminalCommand,
    timeoutMs: number | null,
    execution: TerminalExecution,
  ): ManagedTerminal | undefined;
  onTerminal?(terminal: TerminalObservation): void;
}

export interface TerminalObservation {
  terminalId: string;
  command: TerminalCommand;
  toolCallId?: string;
}

const executionSchema = z
  .object({
    pty: z.boolean(),
    visibility: z.enum(['hidden', 'background', 'foreground']),
  })
  .strict();
export type TerminalExecution = z.infer<typeof executionSchema>;

export interface ManagedTerminal {
  readonly label?: string;
  readonly interactive?: boolean;
  readonly ready: Promise<void>;
  readonly done: Promise<TerminalExitStatus>;
  terminate(reason: string): void;
  snapshot(): TerminalOutputResponse;
  waitForOutput(waitMs: number): Promise<TerminalOutputResponse>;
  assertCleanup(): void;
  waitForHandback?(): Promise<void>;
  reveal?(): void;
  takeover?(): Promise<void>;
  observeOutput?(listener: (snapshot: TerminalOutputResponse) => void): () => void;
}

function abortable<Result>(task: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function environment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR)$/.test(name),
  );
  return { ...Object.fromEntries(inherited), ...overrides };
}

export class RunningTerminal {
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private output = '';
  private truncated = false;
  private status: TerminalExitStatus | undefined;
  private termination: string | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private escalation: NodeJS.Timeout | undefined;
  private cleanupError: unknown;
  private readonly outputObservers = new Set<(snapshot: TerminalOutputResponse) => void>();
  readonly ready: Promise<void>;
  readonly done: Promise<TerminalExitStatus>;

  constructor(
    private readonly command: TerminalCommand,
    timeoutMs: number | null,
    private readonly write?: (text: string) => void,
  ) {
    this.child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: environment(command.env),
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => this.append(decoder.write(chunk)));
      stream.once('end', () => this.append(decoder.end()));
    }
    this.deadline =
      timeoutMs === null ? undefined : setTimeout(() => this.terminate('timeout'), timeoutMs);
    this.child.once('exit', () => this.signalGroup('SIGKILL'));
    this.done = new Promise((resolve) => {
      this.child.once('close', (exitCode, signal) => {
        clearTimeout(this.deadline);
        clearTimeout(this.escalation);
        this.status = { exitCode, signal };
        if (this.termination) this.status._meta = { 'vs-omp/termination': this.termination };
        this.notify();
        resolve(this.status);
      });
    });
  }

  private append(text: string): void {
    this.write?.(text);
    const bytes = Buffer.from(this.output + text);
    let start = Math.max(0, bytes.length - this.command.outputByteLimit);
    this.truncated ||= start > 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.output = bytes.toString('utf8', start);
    this.notify();
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
    if (!this.child.pid) return;
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
    this.termination = reason;
    this.signalGroup('SIGTERM');
    this.escalation = setTimeout(() => this.signalGroup('SIGKILL'), 100);
  }

  input(data: string): boolean {
    if (this.status || this.termination || data !== '\x03') return false;
    this.signalGroup('SIGINT');
    return true;
  }

  snapshot(): TerminalOutputResponse {
    this.assertCleanup();
    return {
      output: this.output,
      truncated: this.truncated,
      exitStatus: this.status && structuredClone(this.status),
    };
  }

  async waitForOutput(waitMs: number): Promise<TerminalOutputResponse> {
    const current = this.snapshot();
    if (current.output || current.exitStatus || !waitMs) return current;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.stdout.removeListener('data', finish);
        this.child.stderr.removeListener('data', finish);
        this.child.removeListener('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.child.stdout.once('data', finish);
      this.child.stderr.once('data', finish);
      this.child.once('close', finish);
    });
    return this.snapshot();
  }

  assertCleanup(): void {
    if (this.cleanupError)
      throw new Error('Terminal process-group cleanup failed.', { cause: this.cleanupError });
  }
}

const RELEASED_HISTORY = 64;

export class TerminalManager {
  private readonly options: TerminalOptions;
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly released = new Set<string>();
  private readonly stopped = new AbortController();
  private readonly timeoutMs: number | null;
  private readonly onAbort: () => void;
  private creating = 0;
  private closing: Promise<void> | undefined;

  constructor(options: TerminalOptions) {
    this.options = { ...options };
    this.onAbort = this.abort.bind(this);
    if (process.platform !== 'linux')
      throw new Error('Terminal execution is validated for Linux only.');
    this.timeoutMs = z
      .number()
      .int()
      .min(10)
      .max(600_000)
      .nullable()
      .parse(options.timeoutMs ?? null);
    if (!options.sessionId || !path.isAbsolute(options.cwd))
      throw new Error('A session and absolute workspace root are required.');
    options.signal.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal.aborted) this.onAbort();
  }

  private abort(): void {
    void this.dispose().catch(() => {});
  }

  private check(sessionId: string): void {
    this.stopped.signal.throwIfAborted();
    this.options.signal.throwIfAborted();
    if (sessionId !== this.options.sessionId)
      throw new Error('Terminal belongs to another session.');
  }

  private async prepare(request: CreateTerminalRequest): Promise<TerminalCommand> {
    const parsed = requestSchema.parse(request);
    const requested = parsed.cwd ?? this.options.cwd;
    if (!path.isAbsolute(requested)) throw new Error('Terminal cwd must be absolute.');
    const root = await realpath(this.options.cwd);
    const cwd = await realpath(requested);
    const relative = path.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('Terminal cwd must be inside the workspace root.');
    if (!(await stat(cwd)).isDirectory()) throw new Error('Terminal cwd must be a directory.');
    return {
      command: parsed.command,
      args: parsed.args,
      env: Object.fromEntries(parsed.env.map(({ name, value }) => [name, value])),
      cwd,
      outputByteLimit: parsed.outputByteLimit ?? 65_536,
    };
  }

  async create(
    request: CreateTerminalRequest,
    executionTimeoutMs: number | null = this.timeoutMs,
    signal: AbortSignal = this.stopped.signal,
    execution: TerminalExecution = { pty: false, visibility: 'hidden' },
    toolCallId?: string,
  ): Promise<CreateTerminalResponse> {
    execution = executionSchema.parse(execution);
    if (executionTimeoutMs !== null)
      z.number().int().min(10).max(600_000).parse(executionTimeoutMs);
    this.check(request.sessionId);
    if (this.terminals.size + this.creating >= 4)
      throw new Error('Release a terminal before creating another.');
    this.creating++;
    try {
      signal = AbortSignal.any([this.stopped.signal, signal]);
      signal.throwIfAborted();
      const command = await abortable(this.prepare(request), signal);
      this.check(request.sessionId);
      if (!(await abortable(this.options.approve(structuredClone(command), signal), signal)))
        throw new Error('Terminal command was not approved.');
      signal.throwIfAborted();
      if ((await abortable(realpath(request.cwd ?? this.options.cwd), signal)) !== command.cwd)
        throw new Error('Terminal cwd changed during approval.');
      this.check(request.sessionId);
      return await this.launch(command, executionTimeoutMs, signal, execution, toolCallId);
    } finally {
      this.creating--;
    }
  }

  async reserve(
    requests: readonly CreateTerminalRequest[],
    signal: AbortSignal = this.stopped.signal,
  ): Promise<ReservedTerminals> {
    if (!requests.length || requests.length > 4) throw new Error('Reserve one to four commands.');
    if (this.terminals.size + this.creating + requests.length > 4)
      throw new Error('Release a terminal before reserving task commands.');
    return reserveCommands(requests, {
      signal: AbortSignal.any([this.stopped.signal, signal]),
      timeoutMs: this.timeoutMs,
      check: (sessionId) => this.check(sessionId),
      prepare: (request) => this.prepare(request),
      approve: (command, currentSignal) => this.options.approve(command, currentSignal),
      launch: (command, timeoutMs, currentSignal) =>
        this.launch(command, timeoutMs, currentSignal, { pty: false, visibility: 'hidden' }),
      capacity: (delta) => {
        this.creating += delta;
      },
    });
  }

  private async launch(
    command: TerminalCommand,
    timeoutMs: number | null,
    signal: AbortSignal,
    execution: TerminalExecution,
    toolCallId?: string,
  ): Promise<CreateTerminalResponse> {
    const launched = this.options.launch?.(command, timeoutMs, execution);
    if (!launched && (execution.pty || execution.visibility !== 'hidden'))
      throw new Error('Integrated terminal execution is unavailable.');
    const terminal = launched ?? new RunningTerminal(command, timeoutMs);
    const terminalId = randomUUID();
    this.terminals.set(terminalId, terminal);
    try {
      this.options.onTerminal?.({ terminalId, command, toolCallId });
    } catch {
      // Streaming is presentation-only; observation failures cannot cancel execution.
    }
    try {
      await abortable(terminal.ready, signal);
      signal.throwIfAborted();
      return { terminalId };
    } catch (error) {
      terminal.terminate('startup-failure');
      await terminal.done;
      this.terminals.delete(terminalId);
      throw error;
    }
  }

  private owned(request: TerminalOutputRequest): ManagedTerminal {
    this.check(request.sessionId);
    const terminal = this.terminals.get(request.terminalId);
    if (!terminal) throw new Error('Unknown or released terminal.');
    return terminal;
  }

  isReleased(request: TerminalOutputRequest): boolean {
    this.check(request.sessionId);
    return this.released.has(request.terminalId);
  }

  output(request: TerminalOutputRequest): TerminalOutputResponse {
    return this.owned(request).snapshot();
  }

  observeOutput(
    request: TerminalOutputRequest,
    listener: (snapshot: TerminalOutputResponse) => void,
  ): () => void {
    const terminal = this.owned(request);
    if (!terminal.observeOutput) throw new Error('Owned task output observation is unavailable.');
    return terminal.observeOutput(listener);
  }

  choices() {
    this.check(this.options.sessionId);
    return [...this.terminals].map(([terminalId, terminal]) => ({
      terminalId,
      label: terminal.label ?? `OMP pipe ${terminalId.slice(0, 8)}`,
      running: !terminal.snapshot().exitStatus,
      interactive: terminal.interactive ?? false,
      visible: !!terminal.reveal,
    }));
  }

  reveal(request: TerminalOutputRequest): void {
    const terminal = this.owned(request);
    if (!terminal.reveal) throw new Error('This terminal cannot be revealed.');
    terminal.reveal();
  }

  async takeover(request: TerminalOutputRequest): Promise<void> {
    const terminal = this.owned(request);
    if (!terminal.takeover) throw new Error('This terminal does not support takeover.');
    await terminal.takeover();
    this.check(request.sessionId);
    terminal.assertCleanup();
  }

  waitForOutput(request: TerminalOutputRequest, waitMs: number): Promise<TerminalOutputResponse> {
    z.number().int().min(0).max(10000).parse(waitMs);
    return this.owned(request).waitForOutput(waitMs);
  }

  async waitForExit(request: TerminalOutputRequest): Promise<TerminalExitStatus> {
    const terminal = this.owned(request);
    const status = await terminal.done;
    await terminal.waitForHandback?.();
    terminal.assertCleanup();
    return structuredClone(status);
  }

  async kill(request: TerminalOutputRequest): Promise<Record<string, never>> {
    const terminal = this.owned(request);
    terminal.terminate('kill');
    await terminal.done;
    terminal.assertCleanup();
    return {};
  }

  async release(request: TerminalOutputRequest): Promise<Record<string, never>> {
    const terminal = this.owned(request);
    this.terminals.delete(request.terminalId);
    terminal.terminate('release');
    await terminal.done;
    terminal.assertCleanup();
    this.released.add(request.terminalId);
    if (this.released.size > RELEASED_HISTORY)
      this.released.delete(this.released.values().next().value!);
    return {};
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    this.closing = Promise.all(terminals.map((terminal) => terminal.done)).then(() => {
      for (const terminal of terminals) terminal.assertCleanup();
    });
    this.stopped.abort(new Error('Terminal scope was cancelled or disposed.'));
    this.options.signal.removeEventListener('abort', this.onAbort);
    for (const terminal of terminals) terminal.terminate('dispose');
    return this.closing;
  }
}
