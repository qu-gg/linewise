import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, messages, message, update, element } from './webview-setup.js';

function terminalBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool-1',
    kind: 'tool',
    toolKind: 'execute',
    command: 'long command',
    status: 'in_progress',
    text: '',
    ...overrides,
  };
}

function liveTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    prompt: 'Run a command',
    status: 'running',
    startedAt: 1,
    blocks: [terminalBlock()],
    ...overrides,
  };
}

function liveState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    connected: true,
    busy: true,
    turns: [liveTurn()],
    ...overrides,
  };
}

function stream(overrides: Record<string, unknown> = {}) {
  message({
    type: 'terminalStream',
    terminalId: 't1',
    turnId: 'turn-1',
    blockId: 'tool-1',
    command: 'long command',
    output: 'partial',
    truncated: false,
    running: true,
    ...overrides,
  });
}

function output(): HTMLElement {
  return element<HTMLElement>('.terminal-tool .tool-output');
}

test('live terminal output renders partial text, a live marker and truncation', () => {
  update(liveState());
  assert.equal(output().textContent, 'Running...');
  assert.equal(element('.terminal-live').hidden, true);
  assert.equal(element('.terminal-truncated').hidden, true);
  stream();
  assert.equal(output().textContent, 'partial');
  assert.equal(element('.terminal-live').hidden, false);
  assert.equal(element('.terminal-truncated').hidden, true);
  stream({ output: 'partial\nmore', truncated: true });
  assert.equal(output().textContent, 'partial\nmore');
  assert.equal(element('.terminal-live').hidden, false);
  assert.equal(element('.terminal-truncated').hidden, false);
  element<HTMLButtonElement>('.terminal-controls').click();
  assert.deepEqual(messages.at(-1), { v: 1, type: 'terminals' });
});

test('live output follows only when the terminal pane is at the bottom', () => {
  update(liveState());
  const pane = output();
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 120 });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 20 });
  pane.scrollTop = 100;
  stream({ output: 'bottom' });
  assert.equal(pane.scrollTop, 120);
  pane.scrollTop = 0;
  stream({ output: 'reading' });
  assert.equal(pane.scrollTop, 0);
  assert.equal(pane.textContent, 'reading');
});

test('a final live snapshot hides the live marker before ACP replacement', () => {
  update(liveState());
  stream({ output: 'done', running: false });
  assert.equal(output().textContent, 'done');
  assert.equal(element('.terminal-live').hidden, true);
});

test('final ACP output replaces the stream and late output cannot reopen it', () => {
  update(liveState());
  stream({ output: 'partial' });
  assert.equal(output().textContent, 'partial');
  update(
    liveState({
      turns: [
        liveTurn({
          status: 'completed',
          blocks: [terminalBlock({ status: 'completed', text: 'final output' })],
        }),
      ],
    }),
  );
  assert.equal(output().textContent, 'final output');
  assert.equal(element('.terminal-live').hidden, true);
  assert.equal(dom.window.document.querySelectorAll('.terminal-tool').length, 1);
  stream({ output: 'late' });
  assert.equal(output().textContent, 'final output');
  assert.equal(element('.terminal-live').hidden, true);
});

test('session switch, cancellation and disconnect retire live terminals', () => {
  update(liveState());
  stream({ output: 'first' });
  assert.equal(output().textContent, 'first');
  update(
    liveState({
      sessionId: 's2',
      turns: [liveTurn({ id: 'turn-2', blocks: [terminalBlock({ id: 'tool-2' })] })],
    }),
  );
  stream({ output: 'stale' });
  assert.equal(output().textContent, 'Running...');
  assert.equal(element('.terminal-live').hidden, true);
  update(
    liveState({
      turns: [liveTurn({ status: 'cancelled', blocks: [terminalBlock({ status: 'cancelled' })] })],
    }),
  );
  stream({ output: 'late' });
  assert.equal(output().textContent, 'No output.');
  assert.equal(element('.terminal-live').hidden, true);
  update(liveState({ connected: false, busy: false }));
  stream({ output: 'offline' });
  assert.equal(element('.terminal-live').hidden, true);
  assert.equal(output().textContent, 'Running...');
});

test('unrelated terminals and malformed messages never attach to a tool card', () => {
  update(liveState());
  stream({ blockId: 'missing', terminalId: 't9' });
  assert.equal(output().textContent, 'Running...');
  assert.equal(element('.terminal-live').hidden, true);
  stream({ turnId: 'missing-turn', terminalId: 't9' });
  assert.equal(output().textContent, 'Running...');
  message({ type: 'terminalStream' });
  message({
    type: 'terminalStream',
    terminalId: 't1',
    turnId: 'turn-1',
    blockId: 'tool-1',
    command: 'long command',
    output: 1,
    truncated: false,
    running: true,
  });
  message({
    type: 'terminalStream',
    terminalId: 't1',
    turnId: 'turn-1',
    blockId: 'tool-1',
    command: 'long command',
    output: 'x'.repeat(262_145),
    truncated: false,
    running: true,
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'terminalStream' } }),
  );
  assert.equal(output().textContent, 'Running...');
  assert.equal(element('.terminal-live').hidden, true);
});
