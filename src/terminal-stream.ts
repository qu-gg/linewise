import type { TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { stripVTControlCharacters } from 'node:util';
import type { ChatBlock } from './state.js';
import type { TerminalCommand, TerminalObservation } from './terminal.js';

export const LIVE_OUTPUT_BYTES = 64 * 1024;
export const LIVE_FLUSH_MS = 100;

export interface StreamTurn {
  id: string;
  status: string;
  blocks: readonly ChatBlock[];
}

export interface TerminalStreamMessage {
  v: 1;
  type: 'terminalStream';
  terminalId: string;
  turnId: string;
  blockId: string;
  command: string;
  output: string;
  truncated: boolean;
  running: boolean;
}

export interface TerminalStreamClock {
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
}

export interface LiveTerminalIdentity {
  terminalId: string;
  command: string;
  toolCallId?: string;
}

export interface TerminalStreamUpdate {
  terminalId: string;
  command: string;
  toolCallId?: string;
  output: string;
  truncated: boolean;
  running: boolean;
}

export interface TerminalStreamOptions {
  turn: () => StreamTurn | undefined;
  observe: (terminalId: string, listener: (snapshot: TerminalOutputResponse) => void) => () => void;
  send: (message: TerminalStreamMessage) => void;
  clock?: TerminalStreamClock;
  flushMs?: number;
  limitBytes?: number;
}

interface LiveBlock {
  id: string;
  kind: string;
  command?: string;
  status?: string;
  text: string;
}

interface StreamTarget {
  turnId: string;
  blockId: string;
}

const defaultClock: TerminalStreamClock = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function terminalFinished(status?: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

const COMMAND_FLAGS: Record<string, true> = {
  '-c': true,
  '-lc': true,
  '-ic': true,
  '--command': true,
  '-e': true,
  '--eval': true,
};

export function terminalCommandText(command: Pick<TerminalCommand, 'command' | 'args'>): string {
  for (let index = command.args.length - 1; index >= 0; index--) {
    const arg = command.args[index];
    if (arg !== undefined && COMMAND_FLAGS[arg] && index + 1 < command.args.length)
      return command.args[index + 1]!;
  }
  return [command.command, ...command.args].join(' ');
}

export function correlateTerminalBlock(
  blocks: readonly LiveBlock[],
  terminal: { command: string; toolCallId?: string },
  claimed: ReadonlySet<string> = new Set<string>(),
): string | undefined {
  const available = blocks.filter(
    (block) =>
      block.kind === 'tool' &&
      !claimed.has(block.id) &&
      !block.text &&
      !terminalFinished(block.status),
  );
  if (terminal.toolCallId) return available.find((block) => block.id === terminal.toolCallId)?.id;
  if (!terminal.command) return undefined;
  return available.find((block) => block.command === terminal.command)?.id;
}

export function boundedLiveOutput(
  output: string,
  limit = LIVE_OUTPUT_BYTES,
  truncated = false,
): { output: string; truncated: boolean } {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= limit) return { output, truncated };
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { output: bytes.toString('utf8', start), truncated: true };
}

export class TerminalLiveTap {
  private readonly attached = new Map<string, { unsubscribe: () => void }>();
  private readonly pending = new Map<string, TerminalStreamUpdate>();
  private readonly clock: TerminalStreamClock;
  private readonly flushMs: number;
  private readonly limitBytes: number;
  private timer: unknown;
  private closed = false;

  constructor(
    private readonly options: {
      emit(update: TerminalStreamUpdate): void;
      clock?: TerminalStreamClock;
      flushMs?: number;
      limitBytes?: number;
    },
  ) {
    this.clock = options.clock ?? defaultClock;
    this.flushMs = options.flushMs ?? LIVE_FLUSH_MS;
    this.limitBytes = options.limitBytes ?? LIVE_OUTPUT_BYTES;
  }

  watch(
    identity: LiveTerminalIdentity,
    subscribe: (listener: (snapshot: TerminalOutputResponse) => void) => () => void,
  ): void {
    if (this.closed) return;
    this.stop(identity.terminalId);
    const record = { unsubscribe: () => {} };
    this.attached.set(identity.terminalId, record);
    try {
      record.unsubscribe = subscribe((snapshot) => this.queue(identity, snapshot));
    } catch {
      if (this.attached.get(identity.terminalId) === record)
        this.attached.delete(identity.terminalId);
      return;
    }
    if (this.attached.get(identity.terminalId) !== record) record.unsubscribe();
  }

  stop(terminalId: string): void {
    const record = this.attached.get(terminalId);
    this.attached.delete(terminalId);
    this.pending.delete(terminalId);
    try {
      record?.unsubscribe();
    } catch {
      // A retired observation cannot affect the owned process.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) {
      this.clock.cancel(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    const records = [...this.attached.values()];
    this.attached.clear();
    for (const record of records) {
      try {
        record.unsubscribe();
      } catch {
        // A retired observation cannot affect the owned process.
      }
    }
  }

  private queue(identity: LiveTerminalIdentity, snapshot: TerminalOutputResponse): void {
    if (this.closed) return;
    const bounded = boundedLiveOutput(
      stripVTControlCharacters(snapshot.output),
      this.limitBytes,
      snapshot.truncated,
    );
    this.pending.set(identity.terminalId, {
      terminalId: identity.terminalId,
      command: identity.command,
      toolCallId: identity.toolCallId,
      output: bounded.output,
      truncated: bounded.truncated,
      running: !snapshot.exitStatus,
    });
    if (snapshot.exitStatus) this.flush();
    else this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
  }

  private flush(): void {
    if (this.timer !== undefined) {
      this.clock.cancel(this.timer);
      this.timer = undefined;
    }
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const update of batch) {
      try {
        this.options.emit(update);
      } catch {
        // Presentation failures cannot affect the owned process.
      }
      if (!update.running) this.stop(update.terminalId);
    }
  }
}

export class TerminalStreamController {
  private readonly tap: TerminalLiveTap;
  private readonly claimed = new Set<string>();
  private readonly targets = new Map<string, StreamTarget>();
  private closed = false;

  constructor(private readonly options: TerminalStreamOptions) {
    this.tap = new TerminalLiveTap({
      emit: (update) => this.emit(update),
      clock: options.clock,
      flushMs: options.flushMs,
      limitBytes: options.limitBytes,
    });
  }

  terminal(terminal: TerminalObservation): void {
    if (this.closed) return;
    const turn = this.options.turn();
    if (!turn || turn.status !== 'running') return;
    const command = terminalCommandText(terminal.command);
    const blockId = correlateTerminalBlock(
      turn.blocks,
      { command, toolCallId: terminal.toolCallId },
      this.claimed,
    );
    if (!blockId) return;
    this.claimed.add(blockId);
    this.targets.set(terminal.terminalId, { turnId: turn.id, blockId });
    this.tap.watch(
      { terminalId: terminal.terminalId, command, toolCallId: terminal.toolCallId },
      (listener) => this.observe(terminal.terminalId, listener),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tap.close();
    this.targets.clear();
    this.claimed.clear();
  }

  private observe(
    terminalId: string,
    listener: (snapshot: TerminalOutputResponse) => void,
  ): () => void {
    try {
      return this.options.observe(terminalId, listener);
    } catch {
      return () => {};
    }
  }

  private emit(update: TerminalStreamUpdate): void {
    if (this.closed) return;
    const target = this.targets.get(update.terminalId);
    const turn = this.options.turn();
    if (!target || !this.isLiveTarget(target, turn)) {
      this.retire(update.terminalId);
      return;
    }
    try {
      this.options.send({
        v: 1,
        type: 'terminalStream',
        terminalId: update.terminalId,
        turnId: target.turnId,
        blockId: target.blockId,
        command: update.command,
        output: update.output,
        truncated: update.truncated,
        running: update.running,
      });
    } catch {
      this.retire(update.terminalId);
    }
  }

  private isLiveTarget(target: StreamTarget, turn: StreamTurn | undefined): boolean {
    if (!turn || turn.id !== target.turnId || turn.status !== 'running') return false;
    const block = turn.blocks.find((candidate) => candidate.id === target.blockId);
    if (!block || block.kind !== 'tool' || block.text || terminalFinished(block.status))
      return false;
    return true;
  }

  private retire(terminalId: string): void {
    this.targets.delete(terminalId);
    this.tap.stop(terminalId);
  }
}
