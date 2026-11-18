import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, messages, update, element, click, input, turn } from './webview-setup.js';

test('running composer exposes distinct Queue and Stop controls and queued items are escaped, collapsible and removable', async () => {
  update({
    busy: true,
    cancellable: true,
    queued: [{ id: 'queued', text: '<script>follow-up</script>' }],
    queuePaused: false,
  });
  assert.equal(element('[data-action="cancel"]').getAttribute('aria-label'), 'Stop');
  assert.equal(element('.send').getAttribute('aria-label'), 'Queue Follow-up');
  assert.equal(element('.follow-ups').tagName, 'DETAILS');
  assert.match(element('.follow-ups summary').textContent!, /Queued Prompts \(1\)/);
  element('.follow-ups summary').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  update({ session: 'Streaming update' });
  assert.equal(element<HTMLDetailsElement>('.follow-ups').open, false);
  element('.follow-ups summary').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  input('#prompt', 'next');
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.deepEqual(messages.at(-1), { v: 1, type: 'queuePrompt', text: 'next' });
  assert.equal(dom.window.document.querySelector('.follow-ups script'), null);
  click('removeQueued');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'removeQueued', id: 'queued' });
  update({ busy: false, queuePaused: true });
  click('resumeQueue');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'resumeQueue' });
  click('clearQueue');
  assert.deepEqual(messages.at(-1), { v: 1, type: 'clearQueue' });
  update({
    busy: true,
    cancellable: true,
    queued: Array.from({ length: 5 }, (_, index) => ({ id: `${index}`, text: 'waiting' })),
  });
  input('#prompt', 'retained full-queue draft');
  assert.equal(element<HTMLButtonElement>('.send').disabled, true);
  const count = messages.length;
  element('#prompt').dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.equal(messages.length, count);
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'retained full-queue draft');
});

test('semantic controls retain focus through streamed rerenders and removed controls return to composer', () => {
  update({
    attachments: [{ id: 'snapshot', label: 'Selected text', uri: 'file:///a' }],
    queued: [{ id: 'q', text: 'next' }],
    queuePaused: true,
  });
  element('[data-action="removeAttachment"]').focus();
  update({ session: 'Stream update' });
  assert.equal(dom.window.document.activeElement, element('[data-action="removeAttachment"]'));
  update({ attachments: [] });
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  element('[data-action="resumeQueue"]').focus();
  update({ busy: true, cancellable: true });
  assert.equal(dom.window.document.activeElement, element('#prompt'));
  update({
    busy: false,
    turns: [turn([{ id: 'tool', kind: 'tool', title: 'Read', text: 'result' }])],
  });
  element('summary').focus();
  update({ session: 'Another update' });
  assert.equal(dom.window.document.activeElement, element('summary'));
  update({ turns: [turn()] });
  element('.model-output').focus();
  update({ session: 'Focused answer' });
  assert.equal(dom.window.document.activeElement, element('.model-output'));
});

test('stable live regions announce status and errors without announcing streamed token changes', () => {
  update({ busy: true, cancellable: true, turns: [{ ...turn(), status: 'running' }] });
  const live = element('[role="status"][aria-live="polite"]');
  const text = live.textContent;
  let mutations = 0;
  const observer = new dom.window.MutationObserver(() => {
    mutations++;
  });
  observer.observe(live, { childList: true });
  update({
    turns: [{ ...turn([{ id: 'answer', kind: 'text', text: 'New tokens' }]), status: 'running' }],
  });
  assert.equal(live, element('[role="status"][aria-live="polite"]'));
  assert.equal(live.textContent, text);
  assert.equal(observer.takeRecords().length, 0);
  assert.equal(mutations, 0);
  update({ busy: false, error: 'Action failed', turns: [turn()] });
  assert.match(live.textContent!, /Ready.*completed/);
  assert.equal(element('[role="alert"]').textContent, 'Action failed');
  observer.disconnect();
});
