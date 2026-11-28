import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dom,
  messages,
  remembered,
  message,
  update,
  element,
  click,
  input,
  turn,
} from './webview-setup.js';

test('composer preserves text, submits once, and blocks whitespace, busy and connecting sends', () => {
  input('#prompt', '  a real prompt  ');
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
  );
  assert.equal(messages.length, 0);
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
  );
  assert.equal(messages.length, 0);
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.deepEqual(messages, [{ v: 1, type: 'prompt', text: '  a real prompt  ' }]);
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
  input('#prompt', '   ');
  assert.equal(element<HTMLButtonElement>('.send').disabled, true);
  update({ connecting: true });
  input('#prompt', 'blocked');
  element('#composer').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }),
  );
  update({ connecting: false, busy: true, cancellable: false });
  element('#composer').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }),
  );
  assert.equal(element<HTMLButtonElement>('[data-action="cancel"]').disabled, true);
  assert.equal(messages.length, 1);
});

test('browser URL exposes an explicit integrated-tab action', () => {
  update({ browserUrl: 'https://example.com/' });
  click('openInBrowser');
  assert.deepEqual(messages, [{ v: 1, type: 'openInBrowser' }]);
  update({ browserUrl: '' });
  assert.equal(dom.window.document.querySelector('[data-action="openInBrowser"]'), null);
});

test('permission control opens an inline menu, confirms elevation and disables unsafe changes', () => {
  assert.equal(dom.window.document.querySelector('.toolbar [data-action="permissions"]'), null);
  assert.equal(
    element('[data-action="permissions"]').previousElementSibling,
    element('.memory-status'),
  );
  for (const [permissions, label] of [
    ['rules', 'Default permissions'],
    ['ask', 'Ask'],
    ['all', 'Allow All'],
    ['yolo', 'YOLO'],
  ]) {
    update({ permissions });
    assert.equal(element('[data-action="permissions"]').textContent, label);
    assert.equal(
      element('[data-action="permissions"]').title,
      `Command Permissions: ${permissions === 'all' ? 'Allow All Except Restrictions' : label}`,
    );
  }
  update({ permissions: 'rules' });
  click('permissions');
  assert.equal(element('#permission-mode-rules').getAttribute('aria-checked'), 'true');
  assert.match(element('.permission-popover').textContent!, /Edit User Command Rules/);
  assert.match(element('#permission-mode-all').textContent!, /Window only/);
  assert.match(element('#permission-mode-yolo').textContent!, /Window only/);
  element('#permission-mode-rules').click();
  assert.equal(dom.window.document.querySelector('.permission-popover'), null);
  assert.equal(messages.length, 0);

  click('permissions');
  element('[data-permission="mode"][data-mode="ask"]').click();
  assert.deepEqual(messages.at(-1), { v: 1, type: 'permissions', mode: 'ask' });
  assert.equal(dom.window.document.querySelector('.permission-popover'), null);

  messages.length = 0;
  click('permissions');
  element('[data-permission="mode"][data-mode="all"]').click();
  assert.equal(messages.length, 0);
  assert.match(element('.permission-warning').textContent!, /without an OS sandbox/);
  assert.match(element('.permission-warning').textContent!, /workbench window/);
  element('#permission-confirm').click();
  assert.deepEqual(messages.at(-1), {
    v: 1,
    type: 'permissions',
    mode: 'all',
    confirmed: true,
  });
  assert.equal(dom.window.document.querySelector('.permission-popover'), null);

  click('permissions');
  element('[data-permission="settings"]').click();
  assert.deepEqual(messages.at(-1), { v: 1, type: 'permissionSettings' });
  for (const status of [
    { busy: true },
    { busy: false, connected: false },
    { connected: true, connecting: true },
  ]) {
    update(status);
    assert.equal(element<HTMLButtonElement>('[data-action="permissions"]').disabled, true);
  }
});

test('terminal picker focus restoration refuses stale, idle and disconnected messages', () => {
  update({ connected: true, busy: true, sessionId: 'owner' });
  element('#prompt').focus();
  message({ type: 'focusTerminals', sessionId: 'foreign' });
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  message({ type: 'focusTerminals', sessionId: 'owner' });
  assert.equal(dom.window.document.activeElement, element('[data-action="terminals"]'));
  for (const status of [{ busy: false }, { busy: true, connected: false }]) {
    update(status);
    element('#prompt').focus();
    message({ type: 'focusTerminals', sessionId: 'owner' });
    assert.notEqual(dom.window.document.activeElement, element('[data-action="terminals"]'));
  }
});

test('drafts stay with their session and selection survives state renders', () => {
  update({ sessionId: 'draft-first' });
  input('#prompt', 'first draft');
  update({ sessionId: 'draft-second' });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
  input('#prompt', 'second draft');
  update({ sessionId: 'draft-first' });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'first draft');
  const field = element<HTMLTextAreaElement>('#prompt');
  field.focus();
  field.setSelectionRange(2, 5);
  update({ host: 'Remote' });
  assert.equal(element<HTMLTextAreaElement>('#prompt').selectionStart, 2);
  assert.equal(element<HTMLTextAreaElement>('#prompt').selectionEnd, 5);
  assert.equal(remembered.drafts!['draft-second'], 'second draft');
  message({ type: 'draft', text: 'forked draft' });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'forked draft');
});

test('model Markdown and prompt metadata cannot inject HTML, script links or event handlers', () => {
  const current = turn([
    {
      id: 'answer',
      kind: 'text',
      text: '**safe** <img src=x onerror=alert(1)><script>bad()</script>[bad](javascript:alert(1)) [web](https://example.com)',
      receivedAt: 1000,
      model: '<svg onload=bad()>',
    },
  ]);
  current.prompt = '<img src=x onerror=bad()>';
  update({ turns: [current] });
  assert.equal(
    dom.window.document.querySelector(
      'img, script, svg, [onerror], [onload], [href^="javascript:"]',
    ),
    null,
  );
  assert.equal(element('.user-message').textContent, current.prompt);
  assert.equal(element('.markdown strong').textContent, 'safe');
  element<HTMLAnchorElement>('.markdown a[href="https://example.com"]').click();
  assert.deepEqual(messages.at(-1), { v: 1, type: 'link', href: 'https://example.com' });
  assert.match(element('.output-metadata').textContent!, /<svg/);
  assert.ok(element('time').getAttribute('datetime'));
});

test('Markdown tables retain semantic headers, rows, inline formatting and safe links', () => {
  update({
    turns: [
      turn([
        {
          id: 'table',
          kind: 'text',
          text: '| Item | Status |\n| --- | --- |\n| **First** | [Ready](https://example.com) |\n| Second | Pending |',
        },
      ]),
    ],
  });
  assert.equal(dom.window.document.querySelectorAll('.markdown table').length, 1);
  assert.equal(dom.window.document.querySelectorAll('.markdown thead th').length, 2);
  assert.equal(dom.window.document.querySelectorAll('.markdown tbody tr').length, 2);
  assert.equal(element('.markdown td strong').textContent, 'First');
  element<HTMLAnchorElement>('.markdown td a').click();
  assert.deepEqual(messages.at(-1), { v: 1, type: 'link', href: 'https://example.com' });
});

test('history editing retains failed drafts, prevents duplicate send, and acknowledges success', () => {
  update({ turns: [turn()] });
  click('forkBefore');
  click('forkAfter');
  assert.deepEqual(
    messages.map((value) => value.boundary),
    ['before', 'after'],
  );
  click('edit');
  input('#history-prompt', 'replacement');
  click('applyEdit');
  assert.equal(remembered.editing!.pending, true);
  click('applyEdit');
  assert.equal(messages.filter((value) => value.type === 'editPrompt').length, 1);
  message({ type: 'editResult', id: 'turn', ok: false });
  assert.equal(element<HTMLTextAreaElement>('#history-prompt').value, 'replacement');
  assert.equal(remembered.editing!.pending, false);
  click('applyEdit');
  message({ type: 'editResult', id: 'turn', ok: true });
  assert.equal(dom.window.document.querySelector('#history-prompt'), null);
});

test('cancel and Escape leave historical prompts untouched and unavailable history stays read-only', () => {
  update({ turns: [turn()] });
  click('edit');
  input('#history-prompt', 'not sent');
  click('cancelEdit');
  assert.equal(messages.length, 0);
  assert.equal(element('.user-message').textContent, 'Original prompt');
  click('edit');
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(dom.window.document.querySelector('#history-prompt'), null);
  update({ canHistory: false });
  assert.equal(dom.window.document.querySelector('[data-action="edit"]'), null);
});

test('review controls send opaque IDs, escape paths, and disable mutations during work', () => {
  update({
    changes: [
      { id: 'first', name: 'src/unsafe<script>.ts', state: 'pending', added: 2, removed: 1 },
      { id: 'second', name: 'main.js', state: 'conflict', added: 1, removed: 3 },
    ],
  });
  assert.equal(dom.window.document.querySelector('script'), null);
  click('review');
  click('keep');
  click('discard');
  click('keepAll');
  click('discardAll');
  assert.deepEqual(
    messages.map(({ type }) => type),
    ['review', 'keep', 'discard', 'keepAll', 'discardAll'],
  );
  assert.deepEqual(messages[0], { v: 1, type: 'review', id: 'first' });
  update({ busy: true });
  for (const action of ['keep', 'discard', 'keepAll', 'discardAll'])
    assert.equal(element<HTMLButtonElement>(`[data-action="${action}"]`).disabled, true);
});

test('disclosure clicks persist their state and historical prompts submit with Enter', async () => {
  update({ turns: [turn([{ id: 'thought-disclosure', kind: 'thought', text: 'Thought' }])] });
  element('.thought summary').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(remembered.expanded?.['thought-disclosure'], true);
  click('edit');
  element('#history-prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.equal(messages.at(-1)!.type, 'editPrompt');
});

test('chat review remains file-level even when granular editor review data is available', () => {
  update({
    changes: [
      {
        id: 'file',
        name: 'file.txt',
        state: 'pending',
        kind: 'edit',
        added: 2,
        removed: 1,
        hunks: [
          {
            id: 'first',
            oldStart: 9,
            newStart: 10,
            preview: [
              ' context',
              '-old',
              '+<img src=x onerror=alert(1)>',
              '\\ No newline at end of file',
            ],
            truncated: true,
          },
        ],
        operations: [{ kind: '<edit>', tool: '<script>', turn: 1, toolCallId: 'native-call' }],
      },
    ],
  });
  assert.equal(
    dom.window.document.querySelector('.inline-diff, .review-hunks, [data-hunk-id]'),
    null,
  );
  assert.equal(dom.window.document.querySelector('script, edit'), null);
  assert.match(element('.file-counts').textContent!, /\+2-1/);
  click('review');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'review', id: 'file' });
  click('keep');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'keep', id: 'file' });
  update({ busy: true });
  for (const type of ['keep', 'discard'])
    assert.equal(element<HTMLButtonElement>(`[data-action="${type}"]`).disabled, true);
});

test('active todos sit immediately above changed files in the dock without duplicates and retain per-session collapse state', async () => {
  const plan = {
    id: 'plan',
    kind: 'plan',
    text: 'plan',
    entries: [
      { content: '<Inspect>', status: 'completed' },
      { content: 'Implement', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ],
  };
  update({
    sessionId: 'task-session',
    turns: [turn([plan])],
    changes: [{ id: 'file', name: 'file.ts', state: 'pending', added: 1, removed: 0 }],
    queued: [{ id: 'queued', text: 'Follow-up prompt' }],
  });
  assert.equal(element('.task-list').parentElement, element('.dock-sections'));
  assert.equal(element('.task-list').closest('.chat-dock'), element('.chat-dock'));
  assert.equal(element('.task-list').previousElementSibling, element('.follow-ups'));
  assert.equal(element('.task-list').nextElementSibling, element('.changes'));
  assert.equal(element('.dock-sections').nextElementSibling, element('#composer'));
  assert.equal(dom.window.document.querySelectorAll('.task-list li').length, 3);
  assert.equal(dom.window.document.querySelector('.activity .plan, Inspect'), null);
  assert.equal(element('.task-count').textContent, '(1/3)');
  assert.equal(element('.task-list summary').textContent, 'Todos (1/3)');
  element('.dock-sections').scrollTop = 64;
  element('.task-list summary').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  update({ busy: true });
  assert.equal(element<HTMLDetailsElement>('.task-list').open, false);
  assert.equal(element('.dock-sections').scrollTop, 64);
  update({ turns: [turn([plan]), { ...turn(), id: 'next', status: 'running' }] });
  assert.equal(dom.window.document.querySelector('.task-list'), null);
  update({ sessionId: 'another-task-session', turns: [turn([plan])] });
  assert.equal(element<HTMLDetailsElement>('.task-list').open, true);
  update({ sessionId: 'task-session', turns: [turn([plan])] });
  assert.equal(element<HTMLDetailsElement>('.task-list').open, false);
});

test('explicit context controls inspect and remove opaque snapshots without injecting attachment labels', () => {
  update({
    attachments: [
      { id: 'snapshot', kind: 'diagnostics', label: '<Problems>', uri: 'file:///workspace' },
    ],
  });
  click('attachContext');
  click('inspectAttachment');
  click('removeAttachment');
  assert.deepEqual(messages, [
    { v: 1, type: 'attachContext' },
    { v: 1, type: 'inspectAttachment', id: 'snapshot' },
    { v: 1, type: 'removeAttachment', id: 'snapshot' },
  ]);
  assert.equal(dom.window.document.querySelector('Problems'), null);
  update({
    attachments: [
      { id: 'pixels', kind: 'image', label: '<chart.png>', uri: 'file:///workspace/chart.png' },
    ],
  });
  assert.ok(dom.window.document.querySelector('.attachment-inspect .codicon-file-media'));
  assert.equal(dom.window.document.querySelector('chart'), null);
  click('inspectAttachment');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'inspectAttachment', id: 'pixels' });
  update({ busy: true });
  assert.equal(element<HTMLButtonElement>('[data-action="attachContext"]').disabled, true);
  assert.equal(element<HTMLButtonElement>('[data-action="removeAttachment"]').disabled, true);
});

test('active file context offer is explicit, escaped, dismissible and blocked during work', () => {
  update({ contextOffer: { id: 'offer', uri: 'file:///workspace/long.txt', label: '<long>.txt' } });
  assert.equal(element('.context-offer [data-action="attachOffer"]').textContent, '<long>.txt');
  assert.equal(dom.window.document.querySelector('.context-offer long'), null);
  assert.equal(messages.length, 0);
  click('attachOffer');
  click('dismissOffer');
  assert.deepEqual(messages, [
    { v: 1, type: 'attachOffer', id: 'offer' },
    { v: 1, type: 'dismissOffer', id: 'offer' },
  ]);
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  element('[data-action="attachOffer"]').focus();
  element('[data-action="attachOffer"]').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.deepEqual(messages.at(-1), { v: 1, type: 'dismissOffer', id: 'offer' });
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  update({ busy: true });
  assert.equal(element<HTMLButtonElement>('[data-action="attachOffer"]').disabled, true);
  update({ contextOffer: undefined, busy: false });
  assert.equal(dom.window.document.querySelector('.context-offer'), null);
});

test('thinking auto-closes when activity advances and terminal failures remain visible', () => {
  const thought = { id: 'active-thought', kind: 'thought', text: 'Reasoning' };
  update({ turns: [{ ...turn([thought]), status: 'running' }] });
  assert.equal(element<HTMLDetailsElement>('.thought').open, true);
  update({
    turns: [
      turn([
        thought,
        { id: 'plan', kind: 'plan', text: '<safe plan>' },
        {
          id: 'tool',
          kind: 'tool',
          toolKind: 'execute',
          title: 'Terminal',
          command: 'echo <safe>',
          status: 'failed',
          text: '<failure>',
        },
        { id: 'answer', kind: 'text', text: 'Done' },
      ]),
    ],
  });
  assert.equal(element<HTMLDetailsElement>('.thought').open, false);
  assert.match(element('.failure').textContent!, /failed/);
  assert.equal(element('.tool-output').textContent, '<failure>');
  assert.equal(element('.plan').textContent, '<safe plan>');
  assert.match(element('.answer-footer .answer-metadata').textContent!, /Timestamp not recorded/);
  click('copyTool');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'copyTool', id: 'tool' });
});

test('context controls show reported values, preserve stale state, and close on Escape or outside click', () => {
  update({
    context: { used: 50, size: 100, stale: true, cost: { amount: 0.125, currency: 'USD' } },
    configs: [
      {
        id: 'model',
        name: 'Model',
        value: 'openrouter/one',
        label: 'First',
        provider: 'openrouter',
      },
      {
        id: 'thinking',
        name: 'Thinking',
        value: 'high',
        options: [
          { name: 'High', value: 'high' },
          { name: 'Medium', value: 'medium' },
        ],
      },
    ],
  });
  click('context');
  assert.match(element('.context-numbers').textContent!, /50%/);
  assert.match(element('.session-cost').textContent!, /0.125 USD/);
  assert.ok(element('.context-note'));
  assert.match(element('.context-popover').textContent!, /Provideropenrouter/);
  assert.match(element('.context-popover').textContent!, /ModelFirst/);
  click('inspectContext');
  click('compact');
  assert.deepEqual(
    messages.map(({ type }) => type),
    ['inspectContext', 'compact'],
  );
  const config = element<HTMLSelectElement>('[data-config="thinking"]');
  config.value = 'medium';
  config.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(messages.at(-1), { v: 1, type: 'config', id: 'thinking', value: 'medium' });
  click('context');
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(dom.window.document.querySelector('.context-popover'), null);
  click('context');
  element('.session-name').click();
  assert.equal(dom.window.document.querySelector('.context-popover'), null);
});

test('generic tool activity renders safe inputs, status and progress separately from the answer', () => {
  for (const status of ['in_progress', 'completed', 'failed']) {
    update({
      turns: [
        turn([
          { id: 'progress', kind: 'text', text: 'Progress' },
          { id: 'generic', kind: 'tool', status, input: '<input>', text: '<output>' },
          { id: 'answer', kind: 'text', text: 'Final answer' },
        ]),
      ],
    });
    assert.equal(element('.progress .markdown').textContent!.trim(), 'Progress');
    assert.equal(element('.command').textContent, '<input>');
    assert.equal(element('.tool-output').textContent, '<output>');
    assert.match(element('.tool summary').textContent!, /Tool/);
    assert.equal(element('.answer .markdown').textContent!.trim(), 'Final answer');
  }
});
