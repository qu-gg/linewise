import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { OwnedBrowser } from '../browser.js';

const html = `<!doctype html><html><head><title>Owned Browser Fixture</title></head><body>
<h1>Owned browser fixture</h1><form id="form"><label>Name <input id="name"></label>
<select id="mode"><option value="one">One</option><option value="two">Two</option></select>
<button id="submit">Record</button></form><p id="result">Waiting</p>
<input id="password" type="password" value="NEVER_EXPOSE_PASSWORD_VALUE">
<button class="ambiguous">First</button><button class="ambiguous">Second</button>
<button id="disabled" disabled>Wait</button><a id="next" href="/second">Next</a>
<button id="popup" onclick="window.open('/popup')">Popup</button>
<button id="error" onclick="console.error('bounded fixture error')">Error</button>
<script>document.getElementById('form').onsubmit = event => {
event.preventDefault();document.getElementById('result').textContent = document.getElementById('name').value + ':' + document.getElementById('mode').value;
};console.log('owned fixture ready');</script></body></html>`;

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(
    request.url === '/second' ? '<!doctype html><title>Second</title><h1>Second page</h1>' : html,
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const abort = new AbortController();
let approvals = 0;
const browser = new OwnedBrowser({
  signal: abort.signal,
  executablePath: process.env.VS_OMP_BROWSER_EXECUTABLE || '/opt/brave.com/brave/brave',
  approve: async () => {
    approvals++;
    return true;
  },
});
const invoke = async (input: unknown) => JSON.parse(await browser.execute(input));
const watchdog = setTimeout(() => abort.abort(new Error('Native browser test watchdog')), 45000);
try {
  const { pageId } = await invoke({ action: 'open', url });
  const call = (action: string, fields: Record<string, unknown> = {}) =>
    invoke({ action, pageId, ...fields });
  const initial = await call('read');
  assert.ok(initial.text.includes('Owned browser fixture'));
  assert.ok(!JSON.stringify(initial).includes('NEVER_EXPOSE_PASSWORD_VALUE'));
  assert.equal((await invoke({ action: 'pages' })).pages.length, 1);
  await call('fill', { selector: '#name', text: 'Exact owned answer' });
  await call('select', { selector: '#mode', values: ['two'] });
  await call('hover', { selector: '#submit' });
  await call('press', { selector: '#name', key: 'Tab' });
  await call('click', { selector: '#submit' });
  assert.ok((await call('read')).text.includes('Exact owned answer:two'));
  await assert.rejects(call('fill', { selector: '#password', text: 'refused' }), /Password/);
  await assert.rejects(call('click', { selector: '.ambiguous' }), /exactly one/);
  await call('click', { selector: '#error' });
  assert.ok(
    (await call('console')).messages.some((message: string) =>
      message.includes('bounded fixture error'),
    ),
  );
  await mkdir('reports/owned-browser', { recursive: true, mode: 0o700 });
  for (const width of [420, 1100]) {
    await call('viewport', { width, height: 800 });
    const image = await call('screenshot');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), width);
    await writeFile(`reports/owned-browser/${width}.png`, bytes, { mode: 0o600 });
  }
  await call('click', { selector: '#popup' });
  assert.equal((await invoke({ action: 'pages' })).pages.length, 1);
  await call('navigate', { url: `${url}second` });
  assert.ok((await call('read')).text.includes('Second page'));
  await call('back');
  await call('forward');
  await call('reload');
  await call('back');
  const extras: string[] = [];
  for (let count = 0; count < 3; count++)
    extras.push((await invoke({ action: 'open', url })).pageId);
  await assert.rejects(invoke({ action: 'open', url }), /four owned pages/);
  for (const extra of extras) await invoke({ action: 'close', pageId: extra });
  await assert.rejects(
    invoke({ action: 'read', pageId: extras[0] }),
    /belongs to this session owner/,
  );
  const pending = call('click', { selector: '#disabled' });
  const stop = setTimeout(() => abort.abort(new Error('Stopped native browser')), 100);
  try {
    await assert.rejects(pending, /Stopped|closed|Target/);
  } finally {
    clearTimeout(stop);
  }
  await browser.dispose();
  await assert.rejects(call('read'), /Stopped/);
  console.log(
    JSON.stringify({
      ownedBrowser: true,
      approvals,
      widths: [420, 1100],
      forms: true,
      history: true,
      exactSelectors: true,
      passwordRefused: true,
      actualPNGs: true,
      Stop: true,
      disposed: true,
      inferenceRequests: 0,
    }),
  );
} finally {
  clearTimeout(watchdog);
  await browser.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
