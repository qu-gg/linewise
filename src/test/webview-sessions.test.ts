import assert from 'node:assert/strict';
import test from 'node:test';
import { dom, element, input, message, messages, update, viewport } from './webview-setup.js';

const DAY = 86_400_000;
const action = (name: string) => element<HTMLButtonElement>(`[data-session="${name}"]`).click();
const key = (selector: string, value: string) =>
  element(selector).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
  );
const checkbox = (checked: boolean) => {
  const field = element<HTMLInputElement>('#session-show-archived');
  field.checked = checked;
  field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
const now = Date.now();
const sessions = [
  {
    id: 'one',
    title: '<First>',
    root: 'file:///workspace/first',
    active: true,
    archived: false,
    pendingReview: true,
    lastActivityAt: now - 2 * DAY,
    added: 2,
    removed: 1,
  },
  {
    id: 'two',
    title: 'Archived title',
    root: 'file:///workspace/second',
    active: false,
    archived: true,
    lastActivityAt: now - 8 * DAY,
  },
];
const wideSessions = () => [
  {
    id: 'today',
    title: 'Active now',
    root: 'file:///workspace/today',
    active: true,
    archived: false,
    pendingReview: true,
    lastActivityAt: Date.now() - 1000,
    added: 2,
    removed: 1,
  },
  {
    id: 'week',
    title: 'This week',
    root: 'file:///workspace/week',
    active: false,
    archived: false,
    lastActivityAt: Date.now() - 4 * DAY,
  },
  {
    id: 'older',
    title: 'Long ago',
    root: 'file:///workspace/older',
    active: false,
    archived: false,
    lastActivityAt: Date.now() - 40 * DAY,
  },
  {
    id: 'archived',
    title: 'Archived item',
    root: 'file:///workspace/archived',
    active: false,
    archived: true,
    lastActivityAt: Date.now() - 2 * DAY,
  },
];

test('session picker searches, filters archived sessions, and switches without generation or deletion', () => {
  update({ sessions });
  message({ type: 'showSessions' });
  assert.equal(dom.window.document.activeElement, element('#session-search'));
  assert.equal(element('.session-open strong').textContent, '<First>');
  assert.equal(element('.session-open').getAttribute('aria-current'), 'true');
  assert.equal(element('.session-diff').textContent, '+2-1');
  assert.match(element('.session-time').textContent!, /2 days ago/);
  assert.equal(dom.window.document.querySelector('.session-open First'), null);
  input('#session-search', 'missing');
  assert.match(element('.session-empty').textContent!, /No matching/);
  input('#session-search', '');
  action('filters');
  checkbox(true);
  assert.equal(
    element('.session-group[data-group="archived"] .session-open strong').textContent,
    'Archived title',
  );
  action('restoreSession');
  checkbox(false);
  assert.equal(dom.window.document.querySelector('.session-group[data-group="archived"]'), null);
  action('archiveSession');
  action('refresh');
  assert.deepEqual(messages, [
    { v: 1, type: 'restoreSession', id: 'two' },
    { v: 1, type: 'archiveSession', id: 'one' },
    { v: 1, type: 'refreshSessions' },
  ]);
  action('toggleSearch');
  assert.equal(dom.window.document.querySelector('#session-search'), null);
  action('toggleSearch');
  assert.ok(element('#session-search'));
  action('close');
  assert.equal(dom.window.document.activeElement, element('#prompt'));
});

test('inactive empty sessions stay out of the picker while the active empty chat remains named', () => {
  const now = Date.now();
  update({
    sessionId: 'active',
    sessions: [
      {
        id: 'active',
        title: 'New Session',
        root: 'file:///workspace',
        active: true,
        archived: false,
        empty: true,
        lastActivityAt: now,
      },
      {
        id: 'abandoned',
        title: 'New Session',
        root: 'file:///workspace',
        active: false,
        archived: false,
        empty: true,
        lastActivityAt: now,
      },
      {
        id: 'named',
        title: 'Prepared chat',
        root: 'file:///workspace',
        active: false,
        archived: false,
        empty: true,
        titled: true,
        lastActivityAt: now,
      },
      {
        id: 'used',
        title: 'Used chat',
        root: 'file:///workspace',
        active: false,
        archived: false,
        empty: false,
        turns: 3,
        lastActivityAt: now,
      },
    ],
  });
  message({ type: 'showSessions' });
  assert.ok(dom.window.document.querySelector('.session-open[data-id="active"]'));
  assert.ok(dom.window.document.querySelector('.session-open[data-id="named"]'));
  assert.ok(dom.window.document.querySelector('.session-open[data-id="used"]'));
  assert.equal(dom.window.document.querySelector('.session-open[data-id="abandoned"]'), null);
  assert.equal(element('.session-open[data-id="active"] strong').textContent, 'New Session');
  assert.equal(element('.session-open[data-id="used"] .session-turns').textContent, '3 prompts');
  action('close');
});

test('an empty session with an unsent draft remains reachable in the picker', () => {
  const now = Date.now();
  const sessions = [
    {
      id: 'active',
      title: 'New Session',
      root: 'file:///workspace',
      active: true,
      archived: false,
      empty: true,
      lastActivityAt: now,
    },
    {
      id: 'abandoned',
      title: 'New Session',
      root: 'file:///workspace',
      active: false,
      archived: false,
      empty: true,
      lastActivityAt: now,
    },
  ];
  update({ sessionId: 'abandoned', sessions });
  input('#prompt', 'Keep this draft');
  update({ sessionId: 'active', sessions });
  message({ type: 'showSessions' });
  assert.ok(element('.session-open[data-id="abandoned"]'));
  action('close');
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
});

test('escape dismisses the session filter menu without closing the picker', () => {
  update({ sessions });
  message({ type: 'showSessions' });
  action('filters');
  assert.ok(element('#session-show-archived'));
  key('[data-session="filters"]', 'Escape');
  assert.equal(dom.window.document.querySelector('#session-show-archived'), null);
  assert.ok(element('.session-manager'));
  action('close');
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

test('manager escape levels, rename cancellation, and failed-save drafts remain usable without accidental submission', () => {
  update({ sessions });
  message({ type: 'showSessions' });
  assert.equal(dom.window.document.activeElement, element('#session-search'));
  key('#session-search', 'Escape');
  assert.ok(element('.session-manager'));
  assert.ok(element('[data-session="toggleSearch"]'));
  key('[data-session="toggleSearch"]', 'Escape');
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  message({ type: 'showSessions' });
  action('toggleSearch');
  action('rename');
  input('#session-title', 'Closed search');
  key('#session-title', 'Escape');
  assert.equal(dom.window.document.querySelector('#session-title'), null);
  assert.equal(messages.length, 0);
  action('toggleSearch');
  action('rename');
  input('#session-title', 'Retain on failed save');
  key('#session-title', 'Enter');
  key('#session-title', 'Enter');
  assert.equal(messages.length, 1);
  update({ error: 'Could not save title.' });
  assert.equal(element<HTMLInputElement>('#session-title').value, 'Retain on failed save');
  assert.equal(element<HTMLInputElement>('#session-title').disabled, false);
  action('cancelRename');
  assert.equal(dom.window.document.querySelector('#session-title'), null);
  key('#session-search', 'Escape');
  key('[data-session="toggleSearch"]', 'Escape');
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  assert.equal(messages.length, 1);
});

test('wide panels show a persistent, collapsible sessions sidebar with grouped activity and diff stats', () => {
  viewport(true, true);
  update({ sessions: wideSessions() });
  assert.ok(element('.session-sidebar'));
  assert.equal(dom.window.document.querySelector('.session-manager.session-surface'), null);
  assert.ok(element('.chat-pane .transcript'));
  assert.equal(
    element('.session-group[data-group="today"] .session-open strong').textContent,
    'Active now',
  );
  assert.equal(
    element('.session-group[data-group="week"] .session-open strong').textContent,
    'This week',
  );
  assert.equal(
    element('.session-group[data-group="older"] .session-open strong').textContent,
    'Long ago',
  );
  assert.equal(element('.session-group[data-group="today"] .session-diff').textContent, '+2-1');
  assert.match(
    element('.session-group[data-group="week"] .session-time').textContent!,
    /4 days ago/,
  );
  assert.match(element('.session-group[data-group="older"] .session-time').textContent!, /month/);
  assert.equal(dom.window.document.querySelector('.session-group[data-group="archived"]'), null);
  action('filters');
  checkbox(true);
  assert.equal(
    element('.session-group[data-group="archived"] .session-open strong').textContent,
    'Archived item',
  );
  action('restoreSession');
  checkbox(false);
  action('new');
  assert.ok(element('.session-sidebar'));
  assert.deepEqual(messages, [
    { v: 1, type: 'restoreSession', id: 'archived' },
    { v: 1, type: 'new' },
  ]);
  action('collapse');
  assert.equal(dom.window.document.querySelector('.session-sidebar'), null);
  assert.ok(element('.chat-pane .transcript'));
  message({ type: 'showSessions' });
  assert.ok(element('.session-sidebar'));
  assert.equal(dom.window.document.activeElement, element('#session-search'));
  viewport(false);
  update({});
  assert.equal(dom.window.document.querySelector('.session-sidebar'), null);
  assert.equal(dom.window.document.querySelector('.session-manager'), null);
  assert.ok(element('.transcript'));
});
