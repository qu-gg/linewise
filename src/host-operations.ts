import type { Turn } from './state.js';

export type Operation =
  | 'connect'
  | 'select'
  | 'prompt'
  | 'history'
  | 'review'
  | 'config'
  | 'context'
  | 'storage'
  | 'disconnect'
  | 'shutdown';

export abstract class HostOperations {
  protected operation: { kind: Operation } | undefined;
  protected abstract operationStarted(kind: Operation): void;
  protected abstract operationSettled(status?: Turn['status']): void;

  protected get busy() {
    return this.operation?.kind === 'prompt';
  }
  protected get connecting() {
    return this.operation?.kind === 'connect' || this.operation?.kind === 'select';
  }
  protected get historyChanging() {
    return this.operation?.kind === 'history';
  }

  protected beginOperation(kind: Operation) {
    if (this.operation) throw new Error('Wait for the current operation to finish.');
    const operation = { kind };
    this.operation = operation;
    this.operationStarted(kind);
    return operation;
  }

  protected endOperation(operation: { kind: Operation }, status?: Turn['status']) {
    const owned = this.operation === operation;
    if (owned) this.operation = undefined;
    this.operationSettled(owned ? status : undefined);
  }

  protected async idleOperation<Result>(
    kind: Operation,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const operation = this.beginOperation(kind);
    try {
      return await action();
    } finally {
      this.endOperation(operation);
    }
  }
}
