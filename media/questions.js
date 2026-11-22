let display = {};

function answerText(answer) {
  if (!Array.isArray(answer?.selected) || answer.selected.length > 8) return;
  if (answer.selected.some((label) => typeof label !== 'string' || label.length > 100)) return;
  if (
    answer.freeText !== undefined &&
    (typeof answer.freeText !== 'string' || answer.freeText.length > 2000)
  )
    return;
  return [...answer.selected, answer.freeText].filter(Boolean).join(', ');
}

function answeredSummary(answers, { escape }) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return '';
  const entries = Object.entries(answers).map(([header, answer]) => ({
    header,
    text: answerText(answer),
  }));
  if (
    !entries.length ||
    entries.length > 4 ||
    entries.some((entry) => entry.header.length > 50 || !entry.text)
  )
    return '';
  return `<dl class="question-review">${entries.map((entry) => `<dt>${escape(entry.header)}</dt><dd>${escape(entry.text)}</dd>`).join('')}</dl>`;
}

function questionOutcome(block) {
  if (
    block.kind !== 'tool' ||
    (block.toolName ?? block.title) !== 'ask' ||
    block.status !== 'completed'
  )
    return '';
  let result;
  try {
    result = JSON.parse(block.text);
  } catch {
    return '';
  }
  if (!result || !['answered', 'cancelled'].includes(result.status)) return '';
  return result;
}

function completedQuestion(block, ui) {
  const result = questionOutcome(block);
  if (!result) return '';
  const cancelled = result.status === 'cancelled';
  const body = cancelled ? '' : answeredSummary(result.answers, ui);
  if (!cancelled && !body) return '';
  const label = cancelled ? 'Questions Cancelled' : 'Answers Submitted';
  return `<section class="question-card question-result" role="region" aria-label="${label}"><header><h3>${ui.icon(cancelled ? 'circle-slash' : 'check')}${label}</h3></header>${body ? `<div class="question-body">${body}</div>` : ''}</section>`;
}

export function questionResults(current, ui) {
  return current.blocks.map((block) => completedQuestion(block, ui)).join('');
}

function initialize(pending) {
  if (display.id !== pending?.id)
    display = {
      id: pending?.id,
      step: 0,
      answers: pending?.questions.map(() => ({ selected: [], freeText: '' })),
    };
}

function choices(question, answer, { escape }) {
  return (question.options ?? [])
    .map(
      (option, index) =>
        `<label class="question-choice"><input id="question-option-${index}" data-question-option="${index}" type="${question.multiSelect ? 'checkbox' : 'radio'}" name="question-choice" ${answer.selected.includes(option.label) ? 'checked' : ''} ${display.sent ? 'disabled' : ''}><span><strong>${escape(option.label)}</strong>${option.recommended ? '<span class="question-recommended">Recommended</span>' : ''}${option.description ? `<small>${escape(option.description)}</small>` : ''}</span></label>`,
    )
    .join('');
}

function review(pending, { escape }) {
  return `<dl class="question-review">${pending.questions.map((question, index) => `<dt>${escape(question.header)}</dt><dd>${escape([...display.answers[index].selected, display.answers[index].freeText].filter(Boolean).join(', '))}</dd>`).join('')}</dl>`;
}

function questionBody(question, answer, ui) {
  return `<fieldset ${display.sent ? 'disabled' : ''}><legend>${ui.escape(question.question)}</legend>${choices(question, answer, ui)}${question.allowFreeformInput ? `<label class="question-custom" for="question-custom">${question.options ? 'Custom answer' : 'Your answer'}</label><textarea id="question-custom" aria-label="${question.options ? 'Custom answer' : 'Your answer'}" maxlength="2000" rows="2">${ui.escape(answer.freeText)}</textarea>` : ''}</fieldset>`;
}

function questionFooter(ui) {
  const action = display.review ? 'submit' : 'next';
  return `<footer><button type="button" class="text-button secondary" data-question="cancel" ${display.sent ? 'disabled' : ''}>Cancel</button><span class="question-navigation">${display.step || display.review ? `<button type="button" class="icon-button" data-question="back" aria-label="Previous Question" title="Previous Question" ${display.sent ? 'disabled' : ''}>${ui.icon('arrow-left')}</button>` : ''}<button type="button" class="text-button" data-question="${action}" ${display.sent ? 'disabled' : ''}>${ui.icon(display.review ? 'check' : 'arrow-right')}${display.review ? 'Submit' : 'Next'}</button></span></footer>`;
}

export function questionCard(state, ui) {
  const pending = state.question;
  initialize(pending);
  if (!pending) return '';
  display.pending = pending;
  const question = pending.questions[display.step];
  return `<section id="question-card-${ui.escape(pending.id)}" class="question-card" data-question-id="${ui.escape(pending.id)}" role="region" aria-labelledby="question-heading" tabindex="-1"><header><h2 id="question-heading">${ui.icon('comment-discussion')}${ui.escape(display.review ? 'Review Answers' : question.header)}</h2><span>${display.review ? '' : `${display.step + 1}/${pending.questions.length}`}</span></header><div class="question-body">${display.review ? review(pending, ui) : questionBody(question, display.answers[display.step], ui)}${display.error ? `<p role="alert" class="question-error">${ui.escape(display.error)}</p>` : ''}</div>${questionFooter(ui)}</section>`;
}

function active(target) {
  return (
    Boolean(display.id) &&
    target.closest?.('.question-card')?.dataset.questionId === display.id &&
    !display.sent
  );
}

function changed(event, render) {
  if (!active(event.target)) return;
  const answer = display.answers[display.step];
  if (event.target.id === 'question-custom') {
    answer.freeText = event.target.value;
    return;
  }
  if (event.target.dataset.questionOption === undefined) return;
  const question = display.pending.questions[display.step];
  const label = question.options[Number(event.target.dataset.questionOption)].label;
  answer.selected = question.multiSelect
    ? [
        ...answer.selected.filter((item) => item !== label),
        ...(event.target.checked ? [label] : []),
      ]
    : [label];
  render();
}

function respond(action, send, render) {
  display.sent = true;
  send(action === 'submit' ? 'questionAnswer' : 'questionCancel', {
    id: display.id,
    ...(action === 'submit'
      ? {
          answers: display.answers.map(({ selected, freeText }) => ({
            selected,
            ...(freeText ? { freeText } : {}),
          })),
        }
      : {}),
  });
  render();
  document.querySelector('#prompt')?.focus({ preventScroll: true });
}

function navigate(action, render) {
  display.error = '';
  if (action === 'back') {
    if (display.review) display.review = false;
    else display.step--;
  } else {
    const answer = display.answers[display.step];
    if (!answer.selected.length && !answer.freeText.trim())
      display.error = 'Choose an answer or enter a custom answer.';
    else if (display.step + 1 === display.pending.questions.length) display.review = true;
    else display.step++;
  }
  render();
  document
    .querySelector('.question-body input, .question-body textarea, [data-question="submit"]')
    ?.focus({ preventScroll: true });
}

export function bindQuestions(send, render) {
  document.addEventListener('change', (event) => changed(event, render));
  document.addEventListener('input', (event) => {
    if (event.target.id === 'question-custom') changed(event, render);
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-question]');
    if (!button || !active(button) || button.disabled) return;
    event.preventDefault();
    const action = button.dataset.question;
    if (['submit', 'cancel'].includes(action)) respond(action, send, render);
    else navigate(action, render);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !active(event.target)) return;
    event.preventDefault();
    respond('cancel', send, render);
  });
}
