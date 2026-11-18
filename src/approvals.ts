import { randomUUID } from 'node:crypto';

export interface ApprovalPrompt {
  kind: 'command' | 'file';
  title: string;
  summary: string;
  details: string;
  notice: string;
  cwd?: string;
  destination?: string;
  configurable?: boolean;
}

export interface PendingApproval extends ApprovalPrompt {
  id: string;
}

export type RequestApproval = (
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  valid: () => boolean,
) => Promise<boolean>;

interface Pending {
  prompt: PendingApproval;
  signal: AbortSignal;
  valid(): boolean;
  finish(allowed: boolean): void;
}

function current(signal: AbortSignal, valid: () => boolean): boolean {
  try {
    return !signal.aborted && valid();
  } catch {
    return false;
  }
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly changed: () => void) {}

  request(prompt: ApprovalPrompt, signal: AbortSignal, valid: () => boolean): Promise<boolean> {
    if (!current(signal, valid) || this.pending.size >= 8) return Promise.resolve(false);
    const captured = { ...structuredClone(prompt), id: randomUUID() };
    return new Promise((resolve) => {
      const abort = () => finish(false);
      const finish = (allowed: boolean) => {
        if (!this.pending.delete(captured.id)) return;
        signal.removeEventListener('abort', abort);
        resolve(allowed);
        this.changed();
      };
      this.pending.set(captured.id, { prompt: captured, signal, valid, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.changed();
      if (signal.aborted) abort();
    });
  }

  snapshot(): { approval: PendingApproval | undefined; approvalCount: number } {
    const first = [...this.pending.values()][0];
    return { approval: structuredClone(first?.prompt), approvalCount: this.pending.size };
  }

  decide(id: string, allowed: boolean): void {
    const first = [...this.pending.values()][0];
    if (first?.prompt.id !== id) return;
    first.finish(allowed && current(first.signal, first.valid));
  }

  cancel(): void {
    for (const entry of [...this.pending.values()]) entry.finish(false);
  }
}
