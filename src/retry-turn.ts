import type { SavedSession } from './state.js';

export interface RetryView {
  active(): SavedSession | undefined;
  editPrompt(id: string, branch: () => Promise<void>): Promise<void>;
}

export async function retryLastTurn(
  view: RetryView,
  id: string,
  branch: (id: string, prompt: string) => Promise<void>,
): Promise<void> {
  const selected = view.active()?.turns.at(-1);
  if (!selected || selected.id !== id || selected.status !== 'completed' || !selected.prompt.trim())
    throw new Error('Retry is available only for the last completed response.');
  await view.editPrompt(id, () => branch(id, selected.prompt));
}
