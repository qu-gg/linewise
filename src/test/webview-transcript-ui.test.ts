import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { dom, messages, remembered, update, element, click, turn } from './webview-setup.js';

function tools() {
  return [
    { id: 'think', kind: 'thought', text: 'Considering the request' },
    {
      id: 'read',
      kind: 'tool',
      toolName: 'Read',
      status: 'completed',
      input: '{"path":"README.md"}',
      text: 'contents',
    },
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
    {
      id: 'write',
      kind: 'tool',
      toolName: 'Write',
      status: 'in_progress',
      input: '{"path":"src/file.ts"}',
      text: '',
    },
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
  assert.equal(element('.prompt-row').getAttribute('aria-label'), 'Your prompt');
  assert.equal(dom.window.document.querySelector('.user-role'), null);
  assert.equal(dom.window.document.querySelector('.assistant-role'), null);
  assert.equal(element('.assistant-answer').getAttribute('aria-label'), 'Assistant answer');
  assert.equal(element('.answer').getAttribute('aria-label'), 'Assistant answer');
  assert.match(element('.answer-footer .answer-metadata').textContent!, /reported\/model/);
  assert.ok(element('.answer-footer time').getAttribute('datetime'));
  const copy = element('[data-action="copyAnswer"]');
  assert.equal(copy.getAttribute('aria-label'), 'Copy Answer');
  assert.equal(copy.textContent!.trim(), '');
  assert.equal(dom.window.document.querySelector('[data-action="regenerate"]'), null);
});

test('activity and tool states are labelled and survive without color-only cues', () => {
  update({ turns: [turn(tools())] });
  assert.equal(element('.activity').dataset.activityStatus, 'completed');
  assert.equal(element('.activity-label').textContent, 'Completed');
  assert.equal(element('.activity > summary .activity-count').textContent, '5 steps');
  assert.match(element('.activity > summary .elapsed').textContent!, /in 1s/);
  assert.match(
    element('.activity > summary').getAttribute('aria-label')!,
    /Completed 5 steps in 1s; 1 passed, 1 failed, 1 cancelled, 1 running/,
  );
  assert.equal(element('.tool[data-tool-status="passed"] .tool-status').textContent, 'Passed');
  assert.equal(element<HTMLElement>('.tool[data-tool-status="passed"] .tool-status').hidden, true);
  assert.equal(element('.tool[data-tool-status="passed"]').dataset.toolIcon, 'file');
  assert.match(element('.tool[data-tool-status="passed"] > summary').textContent!, /Read/);
  assert.match(element('.tool[data-tool-status="passed"] > summary').textContent!, /README\.md/);
  assert.equal(
    element('.tool[data-tool-status="cancelled"] .tool-status').textContent,
    'Cancelled',
  );
  assert.equal(element('.tool[data-tool-status="failed"] .tool-status').textContent, 'Failed');
  assert.equal(element('.tool[data-tool-status="running"] .tool-status').textContent, 'Running');
  assert.equal(element('.tool[data-tool-status="running"]').dataset.toolIcon, 'edit');
  assert.match(element('.tool.status-failed .failure').textContent!, /Terminal failed/);
  assert.match(
    element('.terminal-tool > summary').getAttribute('aria-label')!,
    /Ran echo hi: Failed/,
  );
  assert.equal(
    element('.tool[data-tool-status="passed"] > summary').getAttribute('aria-label'),
    'Read README.md: Passed',
  );
  assert.equal(element('.terminal-tool').dataset.toolStatus, 'failed');
  assert.equal(element('.terminal-tool').dataset.toolIcon, 'terminal');
  assert.equal(element('.terminal-pane').dataset.terminalTool, 'bash');
  assert.equal(element('.terminal-pane .tool-output').textContent, 'boom');
  assert.ok(element('.terminal-heading [data-action="copyTool"]'));
  for (const status of dom.window.document.querySelectorAll('.tool-status')) {
    assert.ok(status.textContent!.trim(), 'tool status must have a text label');
  }
  update({ turns: [{ ...turn(tools()), status: 'cancelled' }] });
  assert.equal(element('.activity').dataset.activityStatus, 'cancelled');
  assert.equal(element('.activity-label').textContent, 'Cancelled');
  update({ turns: [{ ...turn(tools()), startedAt: 0, endedAt: 261000 }] });
  assert.match(element('.activity > summary').textContent!, /Completed 5 steps in 4m 21s/);
  update({ turns: [{ ...turn(tools()), startedAt: 1000, endedAt: 1000 }] });
  assert.doesNotMatch(element('.activity > summary').textContent!, /in 0s/);
  assert.doesNotMatch(element('.activity > summary').getAttribute('aria-label')!, /in 0s/);
  update({
    turns: [{ ...turn([{ id: 'think', kind: 'thought', text: 'Streaming' }]), status: 'running' }],
  });
  assert.equal(element('.activity').dataset.activityStatus, 'running');
  assert.equal(element('.activity-label').textContent, 'Running');
  assert.equal(element<HTMLDetailsElement>('.activity').open, true);
  assert.match(element('.activity > summary').textContent!, /1 step/);
});

test('activity shows only unambiguous per-turn change totals', () => {
  const current = turn(tools());
  update({ turns: [current] });
  const before = element('[data-turn-id="turn"]');
  update({
    turns: [current],
    changes: [
      {
        id: 'one',
        name: 'one.ts',
        state: 'pending',
        added: 2,
        removed: 1,
        operations: [{ turnId: 'turn' }],
      },
      {
        id: 'many',
        name: 'many.ts',
        state: 'pending',
        added: 9,
        removed: 9,
        operations: [{ turnId: 'turn' }, { turnId: 'other' }],
      },
      {
        id: 'other',
        name: 'other.ts',
        state: 'pending',
        added: 4,
        removed: 4,
        operations: [{ turnId: 'other' }],
      },
    ],
  });
  assert.match(element('.activity > summary').textContent!, /\+2 -1/);
  assert.doesNotMatch(element('.activity > summary').textContent!, /\+9/);
  assert.match(element('.activity > summary').getAttribute('aria-label')!, /\+2 -1/);
  assert.notEqual(element('[data-turn-id="turn"]'), before);
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
  assert.match(element('.answer-footer .answer-metadata').textContent!, /Timestamp not recorded/);
  assert.match(element('.answer-footer .answer-metadata').textContent!, /Model not recorded/);
});

test('same-day answer metadata uses a compact time and keeps the exact timestamp', () => {
  const receivedAt = Date.now();
  update({
    turns: [
      turn([{ id: 'answer', kind: 'text', text: 'Final answer', receivedAt, model: 'fixture' }]),
    ],
  });
  const time = element('.answer-footer time');
  assert.equal(time.getAttribute('datetime'), new Date(receivedAt).toISOString());
  assert.match(time.textContent!, /\d{1,2}:\d{2}/);
  assert.doesNotMatch(time.textContent!, /2026/);
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
