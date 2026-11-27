import assert from 'node:assert/strict';
import test from 'node:test';
import { click, dom, element, input, messages, remembered, turn, update } from './webview-setup.js';

const key = (value: string, init: KeyboardEventInit = {}, selector = '#prompt') =>
  element(selector).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: value,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );

const composing = () => {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'ArrowUp',
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'keyCode', { value: 229 });
  return element('#prompt').dispatchEvent(event);
};

const caret = (value: string, start = 0, end = start) => {
  input('#prompt', value);
  const field = element<HTMLTextAreaElement>('#prompt');
  field.setSelectionRange(start, end);
  return field;
};

test('ArrowUp traverses active prompts newest-first, then deduplicated cross-session recents', () => {
  update({
    turns: [
      {
        id: 'first',
        prompt: 'First active',
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        blocks: [],
      },
      {
        id: 'second',
        prompt: 'Second active',
        status: 'completed',
        startedAt: 3,
        endedAt: 4,
        blocks: [],
      },
    ],
    promptHistory: ['First active', 'Recent newest', 'Recent newest', 'Recent older'],
  });
  const field = caret('');
  const before = messages.length;
  assert.equal(key('ArrowDown'), true);
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Second active');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'First active');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Recent newest');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Recent older');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Recent older');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, 'Recent newest');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, 'First active');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, 'Second active');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, '');
  assert.equal(messages.length, before);
  assert.equal(dom.window.document.querySelectorAll('.prompt-row').length, 2);
});

test('recall restores the in-progress draft without submitting or mutating turns', () => {
  update({ turns: [turn()], promptHistory: ['Recent prompt'] });
  const field = caret('work in progress');
  assert.equal(remembered.draft, 'work in progress');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Original prompt');
  assert.equal(remembered.draft, 'work in progress');
  assert.equal(key('ArrowUp'), false);
  assert.equal(field.value, 'Recent prompt');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, 'Original prompt');
  assert.equal(key('ArrowDown'), false);
  assert.equal(field.value, 'work in progress');
  assert.equal(remembered.draft, 'work in progress');
  assert.equal(remembered.drafts?.[remembered.sessionId!], undefined);
  assert.equal(element('.user-message').textContent, 'Original prompt');
  assert.equal(messages.filter((message) => message.type === 'prompt').length, 0);
});

test('recall is per session and the draft survives switching and persisted reload state', () => {
  update({ turns: [turn()], promptHistory: ['Recent prompt'] });
  const first = remembered.sessionId!;
  caret('draft one');
  assert.equal(key('ArrowUp'), false);
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'Original prompt');
  update({ sessionId: 'other-session', turns: [], promptHistory: ['Other recent'] });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
  assert.equal(remembered.drafts?.[first], 'draft one');
  const other = element<HTMLTextAreaElement>('#prompt');
  other.setSelectionRange(0, 0);
  assert.equal(key('ArrowUp'), false);
  assert.equal(other.value, 'Other recent');
  update({ sessionId: first, turns: [turn()], promptHistory: ['Recent prompt'] });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'draft one');
  assert.equal(remembered.draft, 'draft one');
  assert.equal(remembered.sessionId, first);
});

test('recall ignores IME, selections, modified keys, mid-line carets, and other prompt fields', () => {
  update({ turns: [turn()], promptHistory: ['Recent prompt'] });
  const field = caret('typed draft', 3);
  assert.equal(key('ArrowUp'), true);
  assert.equal(field.value, 'typed draft');
  field.setSelectionRange(0, 0);
  assert.equal(key('ArrowUp', { shiftKey: true }), true);
  assert.equal(field.value, 'typed draft');
  assert.equal(key('ArrowUp', { isComposing: true }), true);
  assert.equal(field.value, 'typed draft');
  assert.equal(composing(), true);
  assert.equal(field.value, 'typed draft');
  field.setSelectionRange(0, 3);
  assert.equal(key('ArrowUp'), true);
  field.setSelectionRange(0, 0);
  assert.equal(key('ArrowUp', { ctrlKey: true }), true);
  assert.equal(key('ArrowUp', { altKey: true }), true);
  assert.equal(key('ArrowUp', { metaKey: true }), true);
  field.setSelectionRange(5, 5);
  assert.equal(key('ArrowUp'), true);
  const multiline = caret('line one\nline two', 9);
  assert.equal(key('ArrowUp'), true);
  assert.equal(multiline.value, 'line one\nline two');
  multiline.setSelectionRange(0, 0);
  assert.equal(key('ArrowUp'), false);
  assert.equal(multiline.value, 'Original prompt');
  update({ turns: [turn()] });
  click('edit');
  const historyPrompt = element<HTMLTextAreaElement>('#history-prompt');
  historyPrompt.setSelectionRange(0, 0);
  assert.equal(key('ArrowUp', {}, '#history-prompt'), true);
  assert.equal(historyPrompt.value, 'Original prompt');
});

test('recall leaves native arrows alone when no prompts exist', () => {
  const field = caret('');
  assert.equal(key('ArrowUp'), true);
  assert.equal(key('ArrowDown'), true);
  assert.equal(field.value, '');
  assert.equal(messages.length, 0);
});
