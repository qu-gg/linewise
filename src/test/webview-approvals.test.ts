import assert from 'node:assert/strict';
import test from 'node:test';
import { dom, element, messages, remembered, update, input } from './webview-setup.js';

const command = {
  id: 'command-request',
  kind: 'command',
  title: 'Run bash command?',
  summary: 'printf "<script>"',
  details: 'Executable: /bin/bash\nArguments: ["-c", "printf"]',
  notice: 'Not sandboxed. Allow applies once.',
  cwd: '/workspace',
  configurable: true,
};
function choose(action: string) {
  element<HTMLButtonElement>(`[data-approval="${action}"]`).click();
}

test('command approval scrolls with the conversation outside collapsed activity and escapes payloads', () => {
  update({ busy: true, cancellable: true, approval: command, approvalCount: 2 });
  const card = element('.approval-card');
  const ids = [...card.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(card.closest('.dock-sections, .activity'), null);
  assert.equal(card.parentElement, element('.transcript'));
  assert.equal(element('.chat-dock').contains(card), false);
  assert.equal(dom.window.document.querySelectorAll('.approval-card').length, 1);
  assert.equal(element('.approval-body').contains(element('.approval-meta')), false);
  assert.equal(element('.approval-body').contains(element('.approval-notice')), false);
  assert.equal(card.querySelector('script'), null);
  assert.match(card.textContent!, /<script>/);
  assert.match(card.textContent!, /1\/2/);
  assert.equal(element<HTMLButtonElement>('[data-approval="allow"]').disabled, false);
  assert.match(element('[role="status"]').textContent!, /Approval required: Run bash command/);
  assert.equal(JSON.stringify(remembered).includes('Executable:'), false);
  choose('details');
  assert.equal(element<HTMLDetailsElement>('.approval-details').open, true);
  element('[data-approval="details"]').focus();
  const status = element('[role="status"]');
  update({ error: 'unrelated update' });
  assert.equal(element<HTMLDetailsElement>('.approval-details').open, true);
  assert.equal(dom.window.document.activeElement!.id, 'approval-details-command-request');
  assert.equal(element('[role="status"]'), status);
});

test('Allow and Skip post only one-time ID decisions and cannot double-send', () => {
  update({ busy: true, approval: command });
  choose('allow');
  choose('skip');
  assert.deepEqual(messages, [{ v: 1, type: 'approval', id: command.id, decision: 'allow' }]);
  update({ approval: { ...command, id: 'next' } });
  choose('close');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'approval', id: 'next', decision: 'skip' });
  update({ approval: { ...command, id: 'last' } });
  choose('skip');
  assert.equal(messages.at(-1)!.decision, 'skip');
});

test('options support keyboard dismissal and settings never approve', () => {
  update({ approval: command });
  element('[data-approval="menu"]').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  assert.equal(element<HTMLElement>('.approval-menu').hidden, false);
  assert.equal(dom.window.document.activeElement!.getAttribute('role'), 'menuitem');
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
    element('[role="menuitem"]').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
    );
    assert.equal(dom.window.document.activeElement!.getAttribute('role'), 'menuitem');
  }
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(element<HTMLElement>('.approval-menu').hidden, true);
  element('[data-approval="menu"]').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
  );
  element('[role="menuitem"]').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  assert.equal(element<HTMLElement>('.approval-menu').hidden, true);
  assert.equal(dom.window.document.activeElement!.id, 'approval-menu-command-request');
  choose('menu');
  choose('settings');
  assert.deepEqual(messages, [{ v: 1, type: 'approvalSettings', id: command.id }]);
  assert.equal(element<HTMLElement>('.approval-menu').hidden, true);
  choose('menu');
  element('#prompt').click();
  assert.equal(element<HTMLElement>('.approval-menu').hidden, true);
});

test('inline expansion and details preserve scroll while Escape never grants', () => {
  update({ approval: command });
  choose('details');
  choose('expand');
  assert.equal(element('.approval-card').classList.contains('expanded'), true);
  const body = element('.approval-body');
  body.scrollTop = 42;
  body.dispatchEvent(new dom.window.Event('scroll'));
  update({});
  assert.equal(element('.approval-body').scrollTop, 42);
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(element('.approval-card').classList.contains('expanded'), false);
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(element<HTMLDetailsElement>('.approval-details').open, false);
  assert.deepEqual(messages, []);
});

test('file variants have no empty grant menu and composer Enter does not approve', () => {
  update({
    busy: true,
    cancellable: true,
    approval: {
      ...command,
      id: 'file-request',
      kind: 'file',
      destination: '/new',
      configurable: false,
      cwd: undefined,
    },
  });
  assert.equal(dom.window.document.querySelector('.approval-menu'), null);
  assert.equal(dom.window.document.querySelector('.approval-command'), null);
  assert.equal(dom.window.document.querySelectorAll('.approval-file').length, 2);
  assert.equal(element('.approval-card').nextElementSibling!.id, 'composer');
  assert.equal(element('.approval-card').closest('.transcript'), null);
  assert.equal(dom.window.document.querySelectorAll('.approval-card').length, 1);
  input('#prompt', 'follow-up');
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.equal(messages.at(-1)!.type, 'queuePrompt');
  assert.equal(
    messages.some((message) => message.type === 'approval'),
    false,
  );
  update({ approval: { ...command, id: 'read-request', kind: 'file', configurable: false } });
  assert.equal(dom.window.document.querySelectorAll('.approval-file').length, 1);
  update({ approval: undefined });
  assert.equal(dom.window.document.querySelector('.approval-card'), null);
});
