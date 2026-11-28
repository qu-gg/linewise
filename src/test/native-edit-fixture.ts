import { readFileSync } from 'node:fs';

interface Plan {
  path: string;
  op: string;
  content?: string;
  moveTo?: string;
  requestPath?: string;
  error?: 'before' | 'after' | 'callback';
  paths?: string[];
}

export const recordedSnapshots: Array<{ target: string; seenLines?: number[] | null }> = [];

export const invalidatedSnapshots: string[] = [];

export class EditStore {
  private readonly contents = new Map<string, string>();
  headText(target: string): string | undefined {
    return this.contents.get(target);
  }
  private readonly seen = new Map<string, number[]>();
  recordSnapshotFile(target: string, seenLines?: number[] | null): string {
    recordedSnapshots.push({ target, seenLines });
    this.contents.set(target, readFileSync(target, 'utf8'));
    this.seen.delete(target);
    return 'FAKE';
  }
  recordSeenLines(target: string, _tag: string, lines: number[]): void {
    this.seen.set(
      target,
      [...new Set([...(this.seen.get(target) ?? []), ...lines])].sort(
        (left, right) => left - right,
      ),
    );
  }
  seenLines(target: string, _tag?: string): number[] | null {
    return this.seen.get(target) ?? null;
  }
  invalidate(target: string): void {
    invalidatedSnapshots.push(target);
    this.contents.delete(target);
    this.seen.delete(target);
  }
  recordSeenLinesFromBody(): void {}
}

export function editDescription(): string {
  return 'Injected test engine, not hashline parsing';
}

export function editInspect(_mode: string, json: string) {
  const plan = JSON.parse(JSON.parse(json).input) as Plan;
  return {
    paths: plan.paths ?? [plan.path],
    fileOps: plan.op === 'move' ? [{ kind: 'move', path: plan.path, to: plan.moveTo }] : [],
  };
}

export class EditSession {
  private plan!: Plan;
  setArgsJson(json: string): void {
    this.plan = JSON.parse(JSON.parse(json).input) as Plan;
  }
  finish(): void {}
  close(): void {}
  async apply(
    _options: unknown,
    apply: (error: Error | null, request: unknown) => Promise<unknown>,
  ) {
    if (this.plan.error === 'callback') await apply(new Error('engine callback failed'), {});
    if (this.plan.error !== 'before')
      await apply(null, {
        path: this.plan.requestPath ?? this.plan.path,
        op: this.plan.op,
        content: this.plan.content,
        moveTo: this.plan.moveTo,
        flushLsp: false,
      });
    return { text: 'injected result', isError: !!this.plan.error, files: [] };
  }
}
