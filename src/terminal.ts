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

export interface TerminalCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  outputByteLimit: number;
}

export interface TerminalOptions {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  approve(command: Readonly<TerminalCommand>, signal: AbortSignal): Promise<boolean>;
  timeoutMs?: number;
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

function environment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR)$/.test(name),
  );
  return { ...Object.fromEntries(inherited), ...overrides };
}

class RunningTerminal {
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private output = '';
  private truncated = false;
  private status: TerminalExitStatus | undefined;
  private termination: string | undefined;
  private deadline: NodeJS.Timeout;
  private escalation: NodeJS.Timeout | undefined;
  private cleanupError: unknown;
  readonly ready: Promise<void>;
  readonly done: Promise<TerminalExitStatus>;

  constructor(
    private readonly command: TerminalCommand,
    timeoutMs: number,
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
    this.deadline = setTimeout(() => this.terminate('timeout'), timeoutMs);
    this.child.once('exit', () => this.signalGroup('SIGKILL'));
    this.done = new Promise((resolve) => {
      this.child.once('close', (exitCode, signal) => {
        clearTimeout(this.deadline);
        clearTimeout(this.escalation);
        this.status = { exitCode, signal };
        if (this.termination) this.status._meta = { 'vs-omp/termination': this.termination };
        resolve(this.status);
      });
    });
  }

  private append(text: string): void {
    const bytes = Buffer.from(this.output + text);
    let start = Math.max(0, bytes.length - this.command.outputByteLimit);
    this.truncated ||= start > 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.output = bytes.toString('utf8', start);
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

  snapshot(): TerminalOutputResponse {
    this.assertCleanup();
    return {
      output: this.output,
      truncated: this.truncated,
      exitStatus: this.status && structuredClone(this.status),
    };
  }

  assertCleanup(): void {
    if (this.cleanupError)
      throw new Error('Terminal process-group cleanup failed.', { cause: this.cleanupError });
  }
}

export class TerminalManager {
  private readonly options: TerminalOptions;
  private readonly terminals = new Map<string, RunningTerminal>();
  private readonly stopped = new AbortController();
  private readonly timeoutMs: number;
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
      .parse(options.timeoutMs ?? 120_000);
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

  async create(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.check(request.sessionId);
    if (this.terminals.size + this.creating >= 4)
      throw new Error('Release a terminal before creating another.');
    this.creating++;
    try {
      const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(this.timeoutMs)]);
      const command = await abortable(this.prepare(request), signal);
      this.check(request.sessionId);
      if (!(await abortable(this.options.approve(structuredClone(command), signal), signal)))
        throw new Error('Terminal command was not approved.');
      signal.throwIfAborted();
      if ((await abortable(realpath(request.cwd ?? this.options.cwd), signal)) !== command.cwd)
        throw new Error('Terminal cwd changed during approval.');
      this.check(request.sessionId);
      return await this.launch(command);
    } finally {
      this.creating--;
    }
  }

  private async launch(command: TerminalCommand): Promise<CreateTerminalResponse> {
    const terminal = new RunningTerminal(command, this.timeoutMs);
    const terminalId = randomUUID();
    this.terminals.set(terminalId, terminal);
    try {
      await abortable(terminal.ready, this.stopped.signal);
      this.stopped.signal.throwIfAborted();
      return { terminalId };
    } catch (error) {
      terminal.terminate('startup-failure');
      await terminal.done;
      this.terminals.delete(terminalId);
      throw error;
    }
  }

  private owned(request: TerminalOutputRequest): RunningTerminal {
    this.check(request.sessionId);
    const terminal = this.terminals.get(request.terminalId);
    if (!terminal) throw new Error('Unknown or released terminal.');
    return terminal;
  }

  output(request: TerminalOutputRequest): TerminalOutputResponse {
    return this.owned(request).snapshot();
  }

  async waitForExit(request: TerminalOutputRequest): Promise<TerminalExitStatus> {
    const terminal = this.owned(request);
    const status = await terminal.done;
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
