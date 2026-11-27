import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { dom, messages, remembered, update, element, click, turn } from './webview-setup.js';

function tools() {
  return [
    { id: 'think', kind: 'thought', text: 'Considering the request' },
    { id: 'read', kind: 'tool', toolName: 'Read', status: 'completed', text: 'contents' },
    { id: 'old', kind: 'tool', toolName: 'Old Task', status: 'cancelled', text: '' },
    {
      id: 'bash',
      kind: 'tool',
      toolKind: 'execute',
      title: 'Terminal',
      command: 'echo hi',
      status: 'failed',
      text: 'boom',
    },
    { id: 'write', kind: 'tool', toolName: 'Write', status: 'in_progress', text: '' },
    { id: 'answer', kind: 'text', text: 'Final answer' },
  ];
}

test('transcript names the user, assistant and persistent answer actions', () => {
  update({
    turns: [
      turn([
        {
          id: 'answer',
          kind: 'text',
          text: 'Final answer',
          receivedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
          model: 'reported/model',
        },
      ]),
    ],
  });
  assert.equal(element('.user-message').textContent!.trim(), 'Original prompt');
  assert.equal(element('.user-role').textContent!.trim(), 'You');
  assert.equal(element('.assistant-role').textContent!.trim(), 'Assistant');
  assert.equal(element('.assistant-answer').getAttribute('aria-label'), 'Assistant answer');
  assert.equal(element('.answer').getAttribute('aria-label'), 'Assistant answer');
  assert.match(element('.answer .output-metadata').textContent!, /reported\/model/);
  assert.match(element('.answer .output-metadata').textContent!, /2026/);
  const copy = element('[data-action="copyAnswer"]');
  assert.equal(copy.getAttribute('aria-label'), 'Copy Answer');
  assert.equal(copy.textContent!.trim(), 'Copy');
  assert.equal(dom.window.document.querySelector('[data-action="regenerate"]'), null);
});

test('activity and tool states are labelled and survive without color-only cues', () => {
  update({ turns: [turn(tools())] });
  assert.equal(element('.activity').dataset.activityStatus, 'completed');
  assert.equal(element('.activity-label').textContent, 'Completed');
  assert.match(element('.activity-stats').textContent!, /1 passed/);
  assert.match(element('.activity-stats').textContent!, /1 failed/);
  assert.match(element('.activity-stats').textContent!, /1 cancelled/);
  assert.match(element('.activity-stats').textContent!, /1 running/);
  assert.equal(element('.tool[data-tool-status="passed"] .tool-status').textContent, 'Passed');
  assert.equal(
    element('.tool[data-tool-status="cancelled"] .tool-status').textContent,
    'Cancelled',
  );
  assert.equal(element('.tool[data-tool-status="failed"] .tool-status').textContent, 'Failed');
  assert.equal(element('.tool[data-tool-status="running"] .tool-status').textContent, 'Running');
  assert.match(element('.tool.status-failed .failure').textContent!, /Terminal failed/);
  assert.match(
    element('.terminal-tool > summary').getAttribute('aria-label')!,
    /Terminal failed: echo hi/,
  );
  assert.equal(
    element('.tool[data-tool-status="passed"] > summary').getAttribute('aria-label'),
    'Read: Passed',
  );
  assert.equal(element('.terminal-tool').dataset.toolStatus, 'failed');
  assert.equal(element('.terminal-pane').dataset.terminalTool, 'bash');
  assert.equal(element('.terminal-pane .tool-output').textContent, 'boom');
  assert.ok(element('.terminal-heading [data-action="copyTool"]'));
  for (const status of dom.window.document.querySelectorAll('.tool-status')) {
    assert.ok(status.textContent!.trim(), 'tool status must have a text label');
  }
  for (const stat of dom.window.document.querySelectorAll('.activity-stat')) {
    assert.match(stat.textContent!, /\d+ (passed|failed|cancelled|running)/);
  }
  update({ turns: [{ ...turn(tools()), status: 'cancelled' }] });
  assert.equal(element('.activity').dataset.activityStatus, 'cancelled');
  assert.equal(element('.activity-label').textContent, 'Cancelled');
  update({
    turns: [{ ...turn([{ id: 'think', kind: 'thought', text: 'Streaming' }]), status: 'running' }],
  });
  assert.equal(element('.activity').dataset.activityStatus, 'running');
  assert.equal(element('.activity-label').textContent, 'Running');
  assert.equal(element<HTMLDetailsElement>('.activity').open, true);
  assert.match(element('.activity > summary').textContent!, /1 step/);
});

test('activity and thought disclosures stay collapsed across streamed updates', async () => {
  const thought = { id: 'disclosure-thought', kind: 'thought', text: 'Streaming thought' };
  update({ turns: [{ ...turn([thought]), status: 'running' }] });
  assert.equal(element<HTMLDetailsElement>('.thought').open, true);
  element('.thought > summary').click();
  await delay(0);
  assert.equal(remembered.expanded!['disclosure-thought'], false);
  update({
    turns: [
      {
        ...turn([{ ...thought, text: 'Streaming thought with more tokens' }]),
        status: 'running',
      },
    ],
  });
  assert.equal(element<HTMLDetailsElement>('.thought').open, false);
  element('.thought > summary').click();
  await delay(0);
  assert.equal(remembered.expanded!['disclosure-thought'], true);
});

test('copy answer requests the recorded output without inventing host metadata', () => {
  update({ turns: [turn()] });
  click('copyAnswer');
  assert.deepEqual(messages, [{ v: 1, type: 'copyTool', id: 'answer' }]);
  assert.match(element('.answer .output-metadata').textContent!, /Timestamp not recorded/);
  assert.match(element('.answer .output-metadata').textContent!, /Model not recorded/);
});

test('streamed chunks patch only the changed turn instead of rebuilding the transcript', () => {
  const initial = [0, 1, 2].map((index) => ({
    ...turn([{ id: `answer-${index}`, kind: 'text', text: `Answer ${index}` }]),
    id: `turn-${index}`,
    prompt: `Prompt ${index}`,
  }));
  update({ turns: initial });
  const transcript = element('.transcript');
  const first = element('[data-turn-id="turn-0"]');
  const second = element('[data-turn-id="turn-1"]');
  const last = element('[data-turn-id="turn-2"]');
  update({
    turns: [
      initial[0]!,
      initial[1]!,
      {
        ...initial[2]!,
        blocks: [{ id: 'answer-2', kind: 'text', text: 'Answer 2 streamed' }],
      },
    ],
  });
  assert.equal(element('.transcript'), transcript);
  assert.equal(element('[data-turn-id="turn-0"]'), first);
  assert.equal(element('[data-turn-id="turn-1"]'), second);
  assert.notEqual(element('[data-turn-id="turn-2"]'), last);
  assert.match(element('[data-turn-id="turn-2"]').textContent!, /Answer 2 streamed/);
  assert.equal(dom.window.document.querySelectorAll('.turn').length, 3);
  update({ turns: [initial[0]!, initial[1]!] });
  assert.equal(dom.window.document.querySelectorAll('.turn').length, 2);
  assert.equal(dom.window.document.querySelector('[data-turn-id="turn-2"]'), null);
  update({ turns: [initial[1]!, initial[0]!] });
  assert.deepEqual(
    Array.from(transcript.querySelectorAll('[data-turn-id]')).map((node) =>
      node.getAttribute('data-turn-id'),
    ),
    ['turn-1', 'turn-0'],
  );
});
