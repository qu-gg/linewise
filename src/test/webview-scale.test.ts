import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, update, element, input, turn, remembered } from './webview-setup.js';

test('500-turn Webview rerender preserves draft, caret and complete transcript within a coarse budget', (context) => {
  const turns = Array.from({ length: 500 }, (_, index) => ({
    ...turn([
      { id: `answer-${index}`, kind: 'text', text: `Answer ${index}: ${'content '.repeat(64)}` },
    ]),
    id: `turn-${index}`,
    prompt: `Prompt ${index}`,
  }));
  const started = performance.now();
  update({ turns });
  const rendered = performance.now();
  input('#prompt', 'retained draft');
  const composer = element<HTMLTextAreaElement>('#prompt');
  composer.focus();
  composer.setSelectionRange(3, 8);
  update({
    turns: turns.map((current, index) =>
      index === 499 ? { ...current, prompt: 'Updated final prompt' } : current,
    ),
  });
  const rerendered = performance.now();
  assert.equal(dom.window.document.querySelectorAll('.turn').length, 500);
  assert.match(element('.transcript').textContent!, /Updated final prompt/);
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'retained draft');
  assert.equal(element<HTMLTextAreaElement>('#prompt').selectionStart, 3);
  assert.equal(element<HTMLTextAreaElement>('#prompt').selectionEnd, 8);
  assert.ok(rendered - started < 10000);
  assert.ok(rerendered - rendered < 10000);
  context.diagnostic(
    JSON.stringify({ turns: 500, renderMs: rendered - started, rerenderMs: rerendered - rendered }),
  );
});

test('confirmed session removal clears its remembered draft without clearing the active composer', () => {
  update({ sessionId: 'old-session', sessionIds: ['old-session', 'active-session'] });
  input('#prompt', 'private old draft');
  update({ sessionId: 'active-session' });
  input('#prompt', 'active draft');
  assert.equal(remembered.drafts!['old-session'], 'private old draft');
  update({ sessionIds: ['active-session'] });
  assert.equal(remembered.drafts!['old-session'], undefined);
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'active draft');
  update({ sessionId: 'replacement', sessionIds: ['replacement'] });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, '');
});
