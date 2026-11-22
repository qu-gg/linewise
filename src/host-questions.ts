import * as vscode from 'vscode';
import type { QuestionRequest } from './question-policy.js';

type Question = QuestionRequest['questions'][number];

async function freeText(
  question: Question,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  return vscode.window.showInputBox(
    {
      title: question.header,
      prompt: question.question,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() && value.length <= 2000 ? undefined : 'Enter 1-2000 characters.',
    },
    token,
  );
}

async function selectedAnswer(
  question: Question,
  selection: readonly { label: string; value: string }[],
  token: vscode.CancellationToken,
) {
  const custom = selection.some((item) => item.value === 'custom');
  const text = custom ? await freeText(question, token) : undefined;
  if (custom && text === undefined) return;
  return {
    selected: selection.filter((item) => item.value !== 'custom').map((item) => item.label),
    freeText: text,
  };
}

async function answer(question: Question, token: vscode.CancellationToken) {
  if (!question.options) {
    if (!question.allowFreeformInput)
      throw new Error('A question requires choices or freeform input.');
    const text = await freeText(question, token);
    return text === undefined ? undefined : { selected: [], freeText: text };
  }
  const items = question.options.map((item, index) => ({ ...item, value: String(index) }));
  if (question.allowFreeformInput) items.push({ label: 'Other...', value: 'custom' });
  const options = { title: question.header, placeHolder: question.question, ignoreFocusOut: true };
  const chosen = question.multiSelect
    ? await vscode.window.showQuickPick(items, { ...options, canPickMany: true }, token)
    : await vscode.window.showQuickPick(items, options, token);
  if (chosen === undefined) return;
  return selectedAnswer(question, Array.isArray(chosen) ? chosen : [chosen], token);
}

async function collect(request: QuestionRequest, token: vscode.CancellationToken): Promise<string> {
  const answers: Record<string, unknown> = Object.create(null);
  for (const question of request.questions) {
    if (token.isCancellationRequested) throw new Error('Question cancelled.');
    const result = await answer(question, token);
    if (result === undefined) return JSON.stringify({ status: 'cancelled', answers });
    answers[question.header] = result;
  }
  return JSON.stringify({ status: 'answered', answers });
}

export async function askQuestions(
  request: QuestionRequest,
  signal: AbortSignal,
  valid: () => boolean = () => true,
): Promise<string> {
  signal.throwIfAborted();
  const source = new vscode.CancellationTokenSource();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      source.cancel();
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    const result = await Promise.race([collect(request, source.token), aborted]);
    signal.throwIfAborted();
    if (!valid()) throw new Error('The question owner is stale.');
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    source.dispose();
  }
}
