import assert from 'node:assert/strict';
import test from 'node:test';
import { click, dom, element, turn, update } from './webview-setup.js';

const streamed = (stream: Record<string, unknown>, status = 'running') => ({
  ...turn(),
  status,
  stream,
});

const reading = {
  promptSentAt: 500,
  firstTextAt: 1000,
  lastTextAt: 3000,
  characters: 80,
  decodeMs: 2000,
};

test('Session Info shows estimated output rate and measured first-text time', () => {
  update({ turns: [streamed(reading)] });
  click('context');
  const popover = element('.context-popover');
  assert.match(popover.textContent!, /Output speed/);
  // 80 chars / 4 = 20 estimated tokens over 2 s of decode.
  assert.match(popover.textContent!, /~10\.0 tok\/s/);
  assert.match(popover.textContent!, /First text/);
  assert.match(popover.textContent!, /500 ms/);
  const rate = element('.context-throughput dd');
  assert.match(rate.getAttribute('title') ?? '', /Estimated from stream timing/);
  assert.match(rate.getAttribute('title') ?? '', /not provider-reported/);
  assert.equal(dom.window.document.querySelector('.context-throughput .context-note'), null);
});

test('finished turns show the last observed value with a stale marker', () => {
  update({ turns: [streamed(reading, 'completed')] });
  click('context');
  assert.match(element('.context-popover').textContent!, /~10\.0 tok\/s/);
  assert.match(element('.context-note').textContent!, /Last observed/);
  assert.match(element('.context-throughput dd').getAttribute('title') ?? '', /not live/);
});

test('missing, zero-output, and zero-duration streams hide the row instead of showing NaN', () => {
  const absent = [
    [],
    [{ ...turn(), status: 'completed' }],
    [streamed({ characters: 0, firstTextAt: 1000, lastTextAt: 2000, decodeMs: 1000 })],
    [streamed({ characters: 80, lastTextAt: 2000, decodeMs: 1000 })],
    [streamed({ characters: 80, firstTextAt: 2000, lastTextAt: 2000, decodeMs: 0 })],
    [
      streamed({
        characters: Number.POSITIVE_INFINITY,
        firstTextAt: 1000,
        lastTextAt: 2000,
        decodeMs: 1000,
      }),
    ],
  ];
  for (const turns of absent) {
    update({ turns });
    click('context');
    assert.equal(dom.window.document.querySelector('.context-throughput'), null);
    assert.doesNotMatch(element('.context-popover').textContent!, /NaN|Infinity/);
    click('context');
  }
});
