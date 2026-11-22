import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { questionRequest, type QuestionRequest } from './question-policy.js';

export const questionAnswers = z
  .array(
    z
      .object({
        selected: z.array(z.string().max(100)).max(8),
        freeText: z.string().max(2000).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(4);
export type QuestionAnswers = z.infer<typeof questionAnswers>;
export type PendingQuestion = QuestionRequest & { id: string };
export type RequestQuestions = (
  request: QuestionRequest,
  signal: AbortSignal,
  valid: () => boolean,
) => Promise<string>;

interface Pending {
  prompt: PendingQuestion;
  signal: AbortSignal;
  valid(): boolean;
  finish(value: string, error?: unknown): void;
}
const cancelled = JSON.stringify({ status: 'cancelled', answers: {} });

function current(signal: AbortSignal, valid: () => boolean): boolean {
  try {
    return !signal.aborted && valid();
  } catch {
    return false;
  }
}

function checkedSelection(question: QuestionRequest['questions'][number], selected: string[]) {
  if (new Set(selected).size !== selected.length || (!question.multiSelect && selected.length > 1))
    throw new Error('Choose unique answers within the question selection limit.');
  if (selected.some((label) => !question.options?.some((option) => option.label === label)))
    throw new Error('Choose an offered answer.');
}

function checkedAnswer(
  question: QuestionRequest['questions'][number],
  answer: QuestionAnswers[number],
) {
  const { selected, freeText } = answer;
  checkedSelection(question, selected);
  if (freeText && !question.allowFreeformInput) throw new Error('Custom answers are not allowed.');
  if (!selected.length && !freeText?.trim())
    throw new Error('Answer every question before submitting.');
  return { selected, ...(freeText ? { freeText } : {}) };
}

export class Questions {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly changed: () => void) {}

  readonly request: RequestQuestions = async (request, signal, valid) => {
    signal.throwIfAborted();
    if (!current(signal, valid) || this.pending.size >= 8) return Promise.resolve(cancelled);
    const prompt = { ...questionRequest.parse(structuredClone(request)), id: randomUUID() };
    return new Promise((resolve, reject) => {
      const abort = () => finish(cancelled, signal.reason);
      const finish = (value: string, error?: unknown) => {
        if (!this.pending.delete(prompt.id)) return;
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(value);
        else reject(error);
        this.changed();
      };
      this.pending.set(prompt.id, { prompt, signal, valid, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.changed();
      if (signal.aborted) abort();
    });
  };

  snapshot() {
    return {
      question: structuredClone([...this.pending.values()][0]?.prompt),
      questionCount: this.pending.size,
    };
  }

  answer(id: string, input: unknown): boolean {
    const first = [...this.pending.values()][0];
    if (first?.prompt.id !== id) return false;
    if (!current(first.signal, first.valid)) {
      first.finish(cancelled);
      return false;
    }
    const parsed = questionAnswers.parse(input);
    if (parsed.length !== first.prompt.questions.length) throw new Error('Answer every question.');
    const answers = Object.fromEntries(
      first.prompt.questions.map((question, index) => [
        question.header,
        checkedAnswer(question, parsed[index]!),
      ]),
    );
    first.finish(JSON.stringify({ status: 'answered', answers }));
    return true;
  }

  cancel(id?: string): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) if (!id || entry.prompt.id === id) entry.finish(cancelled);
  }
}
