import assert from 'node:assert/strict';
import test from 'node:test';
import { dom, element, input, message, messages, update } from './webview-setup.js';

const action = (name: string) => element<HTMLButtonElement>(`[data-session="${name}"]`).click();
const sessions = [
  {
    id: 'one',
    title: '<First>',
    root: 'file:///workspace/first',
    active: true,
    archived: false,
    pendingReview: true,
  },
  {
    id: 'two',
    title: 'Archived title',
    root: 'file:///workspace/second',
    active: false,
    archived: true,
  },
];

test('session manager searches and switches recent/archive views without generation or deletion', () => {
  update({ sessions });
  message({ type: 'showSessions' });
  assert.equal(dom.window.document.activeElement, element('#session-search'));
  assert.equal(element('.session-open strong').textContent, '<First>');
  assert.equal(element('.session-open').getAttribute('aria-current'), 'true');
  assert.equal(dom.window.document.querySelector('.session-open First'), null);
  input('#session-search', 'missing');
  assert.match(element('.session-empty').textContent!, /No matching/);
  input('#session-search', '');
  action('archived');
  assert.equal(element('.session-open strong').textContent, 'Archived title');
  action('restoreSession');
  assert.deepEqual(messages, [{ v: 1, type: 'restoreSession', id: 'two' }]);
  action('recent');
  action('archiveSession');
  action('refresh');
  assert.deepEqual(messages.slice(1), [
    { v: 1, type: 'archiveSession', id: 'one' },
    { v: 1, type: 'refreshSessions' },
  ]);
  action('close');
  assert.equal(dom.window.document.activeElement, element('#prompt'));
});

test('session rename is explicit and owner-bound; busy manager keeps Stop and safe browsing reachable', () => {
  update({ sessions });
  message({ type: 'showSessions' });
  action('rename');
  input('#session-title', 'Custom name');
  action('save');
  assert.deepEqual(messages, [{ v: 1, type: 'renameSession', id: 'one', title: 'Custom name' }]);
  update({ sessions: [{ ...sessions[0], title: 'Custom name' }, sessions[1]], busy: true });
  assert.equal(dom.window.document.querySelector('#session-title'), null);
  assert.equal(element<HTMLButtonElement>('[data-session="archiveSession"]').disabled, true);
  assert.equal(element<HTMLButtonElement>('[data-action="cancel"]').disabled, false);
  action('archived');
  action('close');
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
});

test('archiving preserves the old draft without leaking it to new chat, and attention actions leave the manager', () => {
  update({ sessions, sessionId: 'original', sessionIds: ['original'] });
  input('#prompt', 'Original unsent draft');
  update({ sessionId: undefined, sessions: [{ ...sessions[0], id: 'original', archived: true }] });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
  input('#prompt', 'New unsent draft');
  update({ sessionId: 'original' });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'Original unsent draft');
  update({
    question: {
      id: 'current-question',
      questions: [
        {
          header: 'Format',
          question: 'Choose?',
          options: null,
          multiSelect: false,
          allowFreeformInput: true,
        },
      ],
    },
  });
  message({ type: 'showSessions' });
  message({
    type: 'focusAttention',
    kind: 'questions',
    sessionId: 'original',
    id: 'current-question',
  });
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
  assert.equal(dom.window.document.activeElement, element('.question-card'));
  assert.equal(messages.length, 0);
});

test('manager keyboard tabs, rename cancellation, and failed-save drafts remain usable without accidental submission', () => {
  const key = (selector: string, value: string) =>
    element(selector).dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  update({ sessions });
  message({ type: 'showSessions' });
  action('recent');
  for (const [value, selected] of [
    ['ArrowLeft', 'archived'],
    ['ArrowRight', 'recent'],
    ['End', 'archived'],
    ['Home', 'recent'],
  ]) {
    key('[role="tab"][aria-selected="true"]', value!);
    assert.equal(dom.window.document.activeElement, element(`#sessions-${selected}`));
    assert.equal(element<HTMLButtonElement>('[role="tab"][aria-selected="false"]').tabIndex, -1);
  }
  action('rename');
  input('#session-title', 'Never submitted');
  key('#session-title', 'Escape');
  assert.equal(dom.window.document.querySelector('#session-title'), null);
  assert.equal(messages.length, 0);
  action('rename');
  input('#session-title', 'Retain on failed save');
  key('#session-title', 'Enter');
  key('#session-title', 'Enter');
  assert.equal(messages.length, 1);
  update({ error: 'Could not save title.' });
  assert.equal(element<HTMLInputElement>('#session-title').value, 'Retain on failed save');
  assert.equal(element<HTMLInputElement>('#session-title').disabled, false);
  action('cancelRename');
  key('#session-search', 'Escape');
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  assert.equal(messages.length, 1);
});
