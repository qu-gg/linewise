import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
} from '@agentclientprotocol/sdk';
import { stripVTControlCharacters } from 'node:util';
import { taskReadiness } from './task-policy.js';
import type { TerminalManager } from './terminal.js';

export function awaitTaskOperation<Value>(
  pending: PromiseLike<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(pending)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function runOwnedTaskProcess(
  manager: TerminalManager,
  command: CreateTerminalRequest,
  timeout: number | null,
  scope: { signal: AbortSignal; ownerSignal: AbortSignal; check(): void },
  reservation:
    { start(): Promise<CreateTerminalResponse>; readiness?: { line: string } | null } | undefined,
  onReady: (snapshot: TerminalOutputResponse) => void,
): Promise<TerminalOutputResponse> {
  scope.check();
  const handle = reservation
    ? await reservation.start()
    : await manager.create(command, timeout, scope.signal);
  const request = { sessionId: command.sessionId, ...handle };
  let ready: TerminalOutputResponse | undefined;
  try {
    if (reservation?.readiness) {
      ready = await awaitTaskReadiness(manager, request, reservation.readiness.line, scope.signal);
      onReady(ready);
    }
    await awaitTaskOperation(manager.waitForExit(request), scope.signal);
    scope.check();
    scope.signal.throwIfAborted();
    return manager.output(request);
  } catch (error) {
    if (scope.ownerSignal.aborted) {
      await manager.dispose();
      if (!ready) throw error;
      return { ...ready, exitStatus: undefined };
    }
    if (!ready) throw error;
    await manager.kill(request);
    return manager.output(request);
  } finally {
    if (!scope.ownerSignal.aborted) await manager.release(request);
  }
}

export class TaskReadinessError extends Error {
  constructor(readonly snapshot: TerminalOutputResponse) {
    super('Task exited before declared readiness.');
  }
}

export function matchesTaskReadiness(snapshot: TerminalOutputResponse, expected: string): boolean {
  const lines = stripVTControlCharacters(snapshot.output).split('\n');
  lines.pop();
  if (snapshot.truncated) lines.shift();
  return lines.some((line) => line.replace(/\r$/, '') === expected);
}

export function awaitTaskReadiness(
  manager: TerminalManager,
  request: TerminalOutputRequest,
  line: string,
  signal: AbortSignal,
): Promise<TerminalOutputResponse> {
  taskReadiness.parse({ line });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: unknown, snapshot?: TerminalOutputResponse) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener('abort', abort);
      if (snapshot) resolve(snapshot);
      else reject(error);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      unsubscribe = manager.observeOutput(request, (snapshot) => {
        if (snapshot.exitStatus) finish(new TaskReadinessError(snapshot));
        else if (matchesTaskReadiness(snapshot, line)) finish(undefined, snapshot);
      });
      if (settled) unsubscribe();
      else
        void manager.waitForExit(request).then(
          () => {
            try {
              finish(new TaskReadinessError(manager.output(request)));
            } catch (error) {
              finish(error);
            }
          },
          (error: unknown) => finish(error),
        );
      if (signal.aborted) abort();
    } catch (error) {
      finish(error);
    }
  });
}
