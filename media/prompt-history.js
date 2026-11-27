const ARROWS = new Set(['ArrowUp', 'ArrowDown']);

function activePrompts(turns) {
  const prompts = [];
  for (let index = (turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const prompt = turns[index].prompt;
    if (typeof prompt === 'string' && prompt.trim()) prompts.push(prompt);
  }
  return prompts;
}

function appendRecents(prompts, promptHistory) {
  const seen = new Set(prompts);
  for (const prompt of promptHistory ?? []) {
    if (typeof prompt !== 'string' || !prompt.trim() || seen.has(prompt)) continue;
    seen.add(prompt);
    prompts.push(prompt);
  }
}

export function recallPrompts(turns, promptHistory) {
  const prompts = activePrompts(turns);
  appendRecents(prompts, promptHistory);
  return prompts;
}

function traversable(field, event) {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return field.selectionStart === field.selectionEnd && field.selectionStart === 0;
}

export function recallIntent(event) {
  const field = event.target;
  if (field?.id !== 'prompt' || !ARROWS.has(event.key)) return null;
  if (!traversable(field, event)) return null;
  return event.key === 'ArrowUp' ? 'older' : 'newer';
}

export function bindPromptRecall(app, options) {
  const { prompts, getDraft, setDraft, canSubmit } = options;
  let browsing;

  const show = (field, value) => {
    field.value = value;
    field.setSelectionRange(0, 0);
    setDraft(value);
    const send = app.querySelector('.send');
    if (send) send.disabled = !canSubmit(value);
  };

  const older = (event, list) => {
    if (!browsing) browsing = { list, index: 0, draft: getDraft() };
    else if (browsing.index < list.length - 1) browsing.index += 1;
    show(event.target, browsing.list[browsing.index]);
  };

  const newer = (event) => {
    if (browsing.index === 0) {
      const draft = browsing.draft;
      browsing = undefined;
      show(event.target, draft);
      return;
    }
    browsing.index -= 1;
    show(event.target, browsing.list[browsing.index]);
  };

  const keydown = (event) => {
    const direction = recallIntent(event);
    if (!direction || (direction === 'newer' && !browsing)) return;
    const list = browsing ? browsing.list : prompts();
    if (!list.length) return;
    event.preventDefault();
    if (direction === 'older') older(event, list);
    else newer(event);
  };

  app.addEventListener('keydown', keydown);

  return {
    reset() {
      browsing = undefined;
    },
    restore() {
      if (!browsing) return;
      const field = app.querySelector('#prompt');
      if (field) field.setSelectionRange(0, 0);
    },
    get draft() {
      return browsing ? browsing.draft : getDraft();
    },
  };
}
