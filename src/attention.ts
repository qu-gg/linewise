import { z } from 'zod';

const state = z.object({
  sessionId: z.string().optional(),
  busy: z.boolean().optional(),
  error: z.string().optional(),
  approval: z.object({ id: z.string() }).optional(),
  question: z.object({ id: z.string() }).optional(),
  queued: z.array(z.unknown()).optional(),
  turns: z.array(z.object({ id: z.string(), status: z.string() })).optional(),
});

export type AttentionKind = 'approval' | 'questions' | 'finished';
export interface AttentionEvent {
  kind: AttentionKind;
  sessionId: string;
  id: string;
}
export interface AttentionPolicy {
  enabled: boolean;
  approval: boolean;
  questions: boolean;
  finished: boolean;
  backgroundOnly: boolean;
}

function remember(values: Set<string>, key: string) {
  values.add(key);
  if (values.size > 256) values.delete(values.values().next().value!);
}

export class Attention {
  private readonly seen = new Set<string>();
  private readonly running = new Set<string>();

  observe(value: unknown, policy: AttentionPolicy, focused: boolean): AttentionEvent[] {
    const parsed = state.safeParse(value);
    if (!parsed.success || !parsed.data.sessionId) return [];
    const current = parsed.data;
    const sessionId = current.sessionId!;
    const last = current.turns?.at(-1);
    if (last?.status === 'running') remember(this.running, `${sessionId}:${last.id}`);
    const events: AttentionEvent[] = [];
    if (current.approval) events.push({ kind: 'approval', sessionId, id: current.approval.id });
    if (current.question) events.push({ kind: 'questions', sessionId, id: current.question.id });
    if (this.finished(current)) events.push({ kind: 'finished', sessionId, id: last!.id });
    return events.filter((event) => this.admit(event, policy, focused));
  }

  private finished(current: z.infer<typeof state>): boolean {
    const last = current.turns?.at(-1);
    return (
      last?.status === 'completed' &&
      !current.busy &&
      !current.error &&
      !current.queued?.length &&
      this.running.has(`${current.sessionId}:${last.id}`)
    );
  }

  private admit(event: AttentionEvent, policy: AttentionPolicy, focused: boolean): boolean {
    const key = `${event.kind}:${event.sessionId}:${event.id}`;
    if (this.seen.has(key)) return false;
    remember(this.seen, key);
    return policy.enabled && policy[event.kind] && !(policy.backgroundOnly && focused);
  }

  current(event: AttentionEvent, value: unknown): boolean {
    const parsed = state.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== event.sessionId) return false;
    const current = parsed.data;
    if (event.kind === 'approval') return current.approval?.id === event.id;
    if (event.kind === 'questions') return current.question?.id === event.id;
    const last = current.turns?.at(-1);
    return last?.id === event.id && this.finished(current);
  }
}
