import type { CreateTerminalRequest, CreateTerminalResponse } from '@agentclientprotocol/sdk';
import { z } from 'zod';

export interface TerminalCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  outputByteLimit: number;
}

export interface ReservedTerminals {
  start(
    index: number,
    timeoutMs?: number | null,
    validate?: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<CreateTerminalResponse>;
  dispose(): void;
}

interface ReservationOwner {
  signal: AbortSignal;
  timeoutMs: number | null;
  check(sessionId: string): void;
  prepare(request: CreateTerminalRequest): Promise<TerminalCommand>;
  approve(command: TerminalCommand, signal: AbortSignal): Promise<boolean>;
  launch(
    command: TerminalCommand,
    timeoutMs: number | null,
    signal: AbortSignal,
  ): Promise<CreateTerminalResponse>;
  capacity(delta: number): void;
}

function pending<Result>(task: Promise<Result>, signal: AbortSignal): Promise<Result> {
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

export async function reserveCommands(
  requests: readonly CreateTerminalRequest[],
  owner: ReservationOwner,
): Promise<ReservedTerminals> {
  const signal = owner.signal;
  signal.throwIfAborted();
  const originals = structuredClone([...requests]);
  const unused = new Set(originals.map((_request, index) => index));
  const commands: TerminalCommand[] = [];
  owner.capacity(originals.length);
  let retained = false;
  const release = () => {
    owner.capacity(-unused.size);
    unused.clear();
  };
  try {
    for (const request of originals) {
      owner.check(request.sessionId);
      const command = await pending(owner.prepare(request), signal);
      if (!(await pending(owner.approve(structuredClone(command), signal), signal)))
        throw new Error('Terminal command was not approved.');
      commands.push(command);
    }
    signal.throwIfAborted();
    const start = async (
      index: number,
      timeoutMs: number | null = owner.timeoutMs,
      validate?: () => Promise<void>,
      launchSignal: AbortSignal = signal,
    ) => {
      if (!unused.delete(index)) throw new Error('Task command reservation is unavailable.');
      const active = AbortSignal.any([signal, launchSignal]);
      try {
        active.throwIfAborted();
        owner.check(originals[index]!.sessionId);
        if (timeoutMs !== null) z.number().int().min(10).max(600_000).parse(timeoutMs);
        await pending(validate?.() ?? Promise.resolve(), active);
        const fresh = await pending(owner.prepare(originals[index]!), active);
        if (JSON.stringify(fresh) !== JSON.stringify(commands[index]))
          throw new Error('Task command changed after approval.');
        active.throwIfAborted();
        owner.check(originals[index]!.sessionId);
        return await owner.launch(fresh, timeoutMs, active);
      } finally {
        owner.capacity(-1);
      }
    };
    retained = true;
    signal.addEventListener('abort', release, { once: true });
    return {
      start,
      dispose: () => {
        signal.removeEventListener('abort', release);
        release();
      },
    };
  } finally {
    if (!retained) release();
  }
}
