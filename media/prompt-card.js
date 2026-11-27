function editorPrompt(editing, disabled, { state, escape, icon }) {
  const readonly = disabled ? ' readonly' : '';
  const cancel = editing.pending ? ' disabled' : '';
  const apply = disabled || !state.canHistory || !editing.text.trim() ? ' disabled' : '';
  return `<textarea id="history-prompt" aria-label="Edit Previous Prompt"${readonly}>${escape(editing.text)}</textarea><p class="history-note">Files and shared memory stay unchanged.</p><div class="edit-actions"><button type="button" class="text-button secondary" data-action="cancelEdit"${cancel}>Cancel</button><button type="button" class="text-button secondary" data-action="applyEdit"${apply}>${icon('arrow-up')}Send</button></div>`;
}

function promptActions(current, { state, editor, disabled, itemButton }) {
  if (!state.canHistory || !current.history || editor) return '';
  return `<div class="prompt-actions">${itemButton('edit', 'edit', 'Edit and Continue', current.id, disabled)}${itemButton('forkBefore', 'repo-forked', 'Fork Before This Prompt', current.id, disabled)}</div>`;
}

export function promptRow(current, { state, editing, working, escape, icon, itemButton }) {
  const disabled = working() || Boolean(editing?.pending);
  const editor = editing?.id === current.id;
  const prompt = editor
    ? editorPrompt(editing, disabled, { state, escape, icon })
    : escape(current.prompt);
  const actions = promptActions(current, { state, editor, disabled, itemButton });
  return `<div class="prompt-row"><div class="user-message${editor ? ' editing' : ''}">${prompt}</div>${actions}</div>`;
}
