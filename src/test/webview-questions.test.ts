import assert from 'node:assert/strict';
import test from 'node:test';
import { dom, element, input, message, messages, turn, update } from './webview-setup.js';
import { updateTurn } from '../session-updates.js';

const action = (name: string) => element<HTMLButtonElement>(`[data-question="${name}"]`).click();
const question = (extra = {}) => ({
  id: 'request',
  questions: [
    {
      header: 'Format',
      question: 'Choose <format>',
      multiSelect: true,
      allowFreeformInput: true,
      options: [
        { label: 'JSON', description: '<description>', recommended: true },
        { label: 'Text' },
      ],
      ...extra,
    },
  ],
});

test('canonical ask identity survives descriptive streaming titles and renders its completed answer read-only', () => {
  const current: import('../state.js').Turn = {
    id: 'canonical-question',
    prompt: 'Question fixture',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    blocks: [],
  };
  updateTurn(
    current,
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'canonical-ask',
      name: 'ask',
      title: 'Clarifying requested output',
      kind: 'other',
      status: 'in_progress',
    },
    [],
  );
  updateTurn(
    current,
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'canonical-ask',
      title: 'Answers received',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              status: 'answered',
              answers: {
                Output: {
                  selected: ['JSON', 'Text'],
                  freeText: 'Include a short summary',
                },
              },
            }),
          },
        },
      ],
    },
    [],
  );
  assert.equal(current.blocks[0]!.toolName, 'ask');
  assert.equal(current.blocks[0]!.title, 'Answers received');
  update({ question: undefined, turns: [current] });
  assert.match(element('.question-result').textContent!, /Answers Submitted/);
  assert.match(element('.question-result dd').textContent!, /JSON, Text, Include a short summary/);
  assert.equal(
    dom.window.document.querySelector('.question-result button, .question-result input'),
    null,
  );
  update({ turns: [turn([{ ...current.blocks[0], title: 'ask', toolName: 'other' }])] });
  assert.equal(dom.window.document.querySelector('.question-result'), null);
  assert.equal(messages.length, 0);
});

test('completed and cancelled question results are bounded read-only summaries, never revived controls', () => {
  const block = {
    id: 'answered',
    kind: 'tool',
    title: 'ask',
    status: 'completed',
    text: JSON.stringify({
      status: 'answered',
      answers: {
        '<Format>': { selected: ['JSON', '<img src=x>'], freeText: 'Exact custom value' },
      },
    }),
  };
  update({ question: undefined, turns: [turn([block])] });
  assert.match(element('.question-result').textContent!, /Answers Submitted/);
  assert.match(
    element('.question-result dd').textContent!,
    /JSON, <img src=x>, Exact custom value/,
  );
  assert.equal(
    dom.window.document.querySelector(
      '.question-result img, .question-result input, .question-result button',
    ),
    null,
  );
  assert.equal(messages.length, 0);
  update({ sessionId: 'readonly-owner', question: question() });
  message({
    type: 'focusAttention',
    kind: 'questions',
    sessionId: 'readonly-owner',
    id: 'request',
  });
  assert.equal(dom.window.document.activeElement, element('.question-card[data-question-id]'));
  assert.notEqual(dom.window.document.activeElement, element('.question-result'));
  update({ question: undefined });
  update({
    turns: [turn([{ ...block, text: JSON.stringify({ status: 'cancelled', answers: {} }) }])],
  });
  assert.match(element('.question-result').textContent!, /Questions Cancelled/);
  assert.equal(dom.window.document.querySelector('.question-result dl'), null);
  for (const extra of [
    { title: 'other' },
    { status: 'in_progress' },
    { text: 'not JSON' },
    { text: 'null' },
    { text: '{"status":"unknown"}' },
    { text: '{"status":"answered","answers":[]}' },
    { text: JSON.stringify({ status: 'answered', answers: { Invalid: { selected: [12] } } }) },
    {
      text: JSON.stringify({
        status: 'answered',
        answers: { Invalid: { selected: [], freeText: 'x'.repeat(2001) } },
      }),
    },
  ]) {
    update({ turns: [turn([{ ...block, ...extra }])] });
    assert.equal(dom.window.document.querySelector('.question-result'), null);
  }
  assert.equal(messages.length, 0);
});

test('notification focus messages are owner-bound, focus only and keep the composer in keyboard order', () => {
  update({ sessionId: 'owner', question: question() });
  const prompt = element<HTMLTextAreaElement>('#prompt');
  prompt.focus();
  message({ type: 'focusAttention', kind: 'questions', sessionId: 'foreign', id: 'request' });
  message({ type: 'focusAttention', kind: 'questions', sessionId: 'owner', id: 'stale' });
  assert.equal(dom.window.document.activeElement, prompt);
  message({ type: 'focusAttention', kind: 'questions', sessionId: 'owner', id: 'request' });
  assert.equal(dom.window.document.activeElement, element('.question-card'));
  update({ questionCount: 1 });
  assert.equal(dom.window.document.activeElement, element('.question-card[data-question-id]'));
  assert.equal(element('.question-card[data-question-id]').getAttribute('tabindex'), '-1');
  assert.equal(messages.length, 0);
  update({
    question: undefined,
    approval: {
      id: 'approval',
      kind: 'command',
      title: 'Run Command',
      summary: 'echo sample',
      details: '',
      notice: '',
    },
  });
  message({ type: 'focusAttention', kind: 'approval', sessionId: 'owner', id: 'approval' });
  assert.equal(dom.window.document.activeElement, element('.approval-card'));
  update({ approvalCount: 1 });
  assert.equal(dom.window.document.activeElement, element('.approval-card'));
  assert.equal(element('.approval-card').tabIndex, -1);
  assert.equal(messages.length, 0);
  update({ approval: undefined });
  message({ type: 'focusAttention', kind: 'finished', sessionId: 'owner', id: 'completed' });
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  assert.equal(element('#prompt').tabIndex, 0);
  element('#prompt').remove();
  message({ type: 'focusAttention', kind: 'finished', sessionId: 'owner', id: 'completed' });
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  assert.deepEqual(messages, [
    { v: 1, type: 'focus', focused: true },
    { v: 1, type: 'focus', focused: false },
  ]);
});

test('explicit attention survives native focus arriving after its animation frame without stealing input', async (context) => {
  const { settleAttentionFocus } = await import(
    new URL('../../media/accessibility.js', import.meta.url).href
  );
  const frames: FrameRequestCallback[] = [];
  let focused = false;
  let repairs = 0;
  context.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  context.mock.method(dom.window.document, 'hasFocus', () => focused);
  const root = element('#app');
  dom.window.document.activeElement instanceof dom.window.HTMLElement &&
    dom.window.document.activeElement.blur();
  settleAttentionFocus(root, () => repairs++);
  frames.shift()!(0);
  assert.equal(repairs, 0);
  focused = true;
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(repairs, 1);
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(repairs, 1);
  focused = false;
  settleAttentionFocus(root, () => repairs++);
  frames.shift()!(0);
  focused = true;
  element<HTMLTextAreaElement>('#prompt').focus();
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(repairs, 1);
});

test('explicit notification focus repairs one native handoff but never revives a retired request', (context) => {
  update({
    sessionId: 'owner',
    approval: { id: 'approval', kind: 'command', title: 'Run Command', summary: 'sample' },
  });
  const frames: FrameRequestCallback[] = [];
  context.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  context.mock.method(dom.window.document, 'hasFocus', () => true);
  const attention = {
    type: 'focusAttention',
    kind: 'approval',
    sessionId: 'owner',
    id: 'approval',
  };
  message(attention);
  element('.approval-card').blur();
  frames.shift()!(0);
  assert.equal(dom.window.document.activeElement, element('.approval-card'));
  assert.equal(frames.length, 0);
  message(attention);
  element('.approval-card').blur();
  update({ approval: undefined });
  frames.shift()!(0);
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
  for (const callback of frames.splice(0)) callback(0);
  assert.equal(dom.window.document.querySelector('.approval-card'), null);
  assert.equal(messages.length, 0);
});

test('chat question card requires explicit answers and a final review before exactly one submission', () => {
  update({ busy: true, question: question() });
  assert.equal(dom.window.document.querySelectorAll('.question-choice input:checked').length, 0);
  assert.equal(element('.question-choice small').textContent, '<description>');
  assert.equal(dom.window.document.querySelector('.question-card description'), null);
  action('next');
  assert.ok(element('.question-error'));
  element<HTMLInputElement>('#question-option-0').click();
  element<HTMLInputElement>('#question-option-1').click();
  input('#question-custom', 'also custom');
  action('next');
  assert.match(element('.question-review').textContent!, /JSON, Text, also custom/);
  assert.equal(messages.length, 0);
  action('back');
  assert.equal(element<HTMLInputElement>('#question-option-0').checked, true);
  action('next');
  action('submit');
  action('submit');
  assert.deepEqual(messages, [
    {
      v: 1,
      type: 'questionAnswer',
      id: 'request',
      answers: [{ selected: ['JSON', 'Text'], freeText: 'also custom' }],
    },
  ]);
  assert.equal(dom.window.document.activeElement, element('#prompt'));
});

test('single choice forbids extra selections, freeform-only input and Escape cancel remain explicit', () => {
  update({ question: question({ multiSelect: false, allowFreeformInput: false }) });
  assert.equal(dom.window.document.querySelector('#question-custom'), null);
  element<HTMLInputElement>('#question-option-0').click();
  element<HTMLInputElement>('#question-option-1').click();
  assert.equal(dom.window.document.querySelectorAll('.question-choice input:checked').length, 1);
  update({
    question: {
      id: 'free',
      questions: [
        {
          header: 'Details',
          question: 'Your details?',
          options: null,
          multiSelect: false,
          allowFreeformInput: true,
        },
      ],
    },
  });
  input('#question-custom', 'Free only');
  action('next');
  assert.match(element('.question-review').textContent!, /Free only/);
  action('back');
  element('#question-custom').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.deepEqual(messages, [{ v: 1, type: 'questionCancel', id: 'free' }]);
  update({ question: undefined });
  assert.equal(dom.window.document.querySelector('.question-card'), null);
  const errors: Event[] = [];
  const record = (event: Event) => errors.push(event);
  dom.window.addEventListener('error', record);
  element('#prompt').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  dom.window.removeEventListener('error', record);
  assert.deepEqual(errors, []);
});
