import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { access, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PendingApproval } from '../approvals.js';
import { browserRequest } from '../browser-policy.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (
  text: string,
  approve: (approval: PendingApproval) => boolean | undefined,
) => Promise<string>;

const startSource = "await import('./managed-preview.mjs')";
const browserSource = "await import('./browser-check.mjs')";

function approveFixture(approval: PendingApproval): boolean {
  if (approval.kind !== 'command') return false;
  const fields = approval.details.split('\n\n');
  const executable = JSON.parse(
    fields.find((field) => field.startsWith('Executable: '))!.slice(12),
  );
  const args = JSON.parse(fields.find((field) => field.startsWith('Arguments: '))!.slice(11));
  return (
    executable === process.execPath &&
    args.length === 3 &&
    args[0] === '--input-type=module' &&
    args[1] === '-e' &&
    [startSource, browserSource].includes(args[2].trim().replace(/;$/, ''))
  );
}

export async function seedBrowser(root: string) {
  const source = process.env.VS_OMP_LIVE_SOURCE_ROOT!;
  const browser = process.env.VS_OMP_LIVE_BROWSER_PATH || '/opt/brave.com/brave/brave';
  await access(browser);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await cp(path.join(source, 'scripts/preview.mjs'), path.join(root, 'scripts/preview.mjs'));
  await cp(
    path.join(source, 'scripts/preview-data.mjs'),
    path.join(root, 'scripts/preview-data.mjs'),
  );
  await cp(path.join(source, 'dist/webview'), path.join(root, 'dist/webview'), { recursive: true });
  await symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(
    path.join(root, 'managed-preview.mjs'),
    `
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
process.env.PORT='0';
const {server}=await import('./scripts/preview.mjs');
if(!server.listening)await once(server,'listening');
await writeFile('preview-url.json',JSON.stringify({url:'http://127.0.0.1:'+server.address().port,pid:process.pid}));
console.log('PREVIEW_READY');
`,
  );
  await writeFile(
    path.join(root, 'browser-check.mjs'),
    `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const {url}=JSON.parse(await readFile('preview-url.json','utf8'));
const browser=await chromium.launch({executablePath:${JSON.stringify(browser)},headless:true,args:['--no-sandbox']});
const views=[];
try{
for(const width of [420,1100]){
const page=await browser.newPage({viewport:{width,height:900}});
page.setDefaultTimeout(5000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto(url,{waitUntil:'networkidle',timeout:15000});
assert.equal(await page.title(),'OMP Webview Fixture');
const buttons=await page.getByRole('button').count();assert.ok(buttons>8);
const queue=page.getByRole('button',{name:'Queue Follow-up',exact:true});
assert.equal(await queue.isDisabled(),true);
await page.getByRole('textbox',{name:'Message OMP',exact:true}).fill('BROWSER_FOLLOW_UP_SENTINEL');
assert.equal(await queue.isEnabled(),true);
await queue.click();
const queued=page.locator('.follow-ups li').filter({hasText:'BROWSER_FOLLOW_UP_SENTINEL'});
await queued.waitFor({state:'visible'});
assert.equal(await page.getByRole('textbox',{name:'Message OMP',exact:true}).inputValue(),'');
await queued.getByRole('button',{name:'Remove Follow-up',exact:true}).click();
await queued.waitFor({state:'hidden'});
const context=page.getByRole('button',{name:'Session Context',exact:true});
await context.click();
assert.equal(await context.getAttribute('aria-expanded'),'true');
await page.keyboard.press('Escape');
assert.equal(await context.getAttribute('aria-expanded'),'false');
const attachment=page.locator('[data-action="removeAttachment"][data-id="preview-problems"]');
assert.equal(await attachment.isDisabled(),true);
await page.locator('button[data-approval="skip"]').click();
await page.locator('button[data-approval="skip"]').waitFor({state:'hidden'});
assert.equal(await attachment.isEnabled(),true);
await attachment.click();
await attachment.waitFor({state:'hidden'});
assert.deepEqual(errors,[]);
await page.screenshot({path:'browser-'+width+'.png',fullPage:true});
views.push({width,buttons,skipClicked:true,queueRoundTrip:true,contextEscape:true,attachmentRemoved:true,title:await page.title()});
await page.close();
}
await writeFile('browser-result.json',JSON.stringify({passed:true,node:process.version,url,views}));
console.log(JSON.stringify({passed:true,node:process.version,views}));
}finally{await browser.close();}
`,
  );
}

export async function browserWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  await seedBrowser(root);
  const pending = new Map<string, number>();
  const approveAfterDelay = (approval: PendingApproval) => {
    if (!approveFixture(approval)) return false;
    if (!pending.has(approval.id)) pending.set(approval.id, Date.now());
    return Date.now() - pending.get(approval.id)! >= 1500 ? true : undefined;
  };
  await prompt(
    'Please start the supplied OMP Webview fixture on its ephemeral loopback port, inspect it with Playwright, and report the visual and interaction results. ' +
      'Use bash runtime node with action start and exactly this JavaScript command: ' +
      JSON.stringify(startSource) +
      ', with timeout 1. Wait for startup output with action output and waitMs 10000. ' +
      'Then use runtime node/action run, timeout 120, and exactly this JavaScript command: ' +
      JSON.stringify(browserSource) +
      '. The supplied checker inspects mobile/desktop views, validates submission, adds/removes a queued prompt, dismisses context with Escape, removes an attachment, clicks Skip, and writes screenshots and browser-result.json. ' +
      'Read browser-420.png and browser-1100.png with read and visually describe the rendered controls and layout. ' +
      'Stop your managed job when done. Do not install dependencies, detach, or use other commands.',
    approveAfterDelay,
  );
  const result = JSON.parse(await readFile(path.join(root, 'browser-result.json'), 'utf8'));
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.views.map((view: { width: number }) => view.width),
    [420, 1100],
  );
  assert.match(result.node, /^v(?:2\d|[3-9]\d)\./);
  const observer = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  assert.ok(
    observer.results.filter(
      (entry: { name: string; imageCount: number }) =>
        entry.name === 'read' && entry.imageCount > 0,
    ).length >= 2,
  );
  for (const width of [420, 1100]) {
    const screenshot = path.join(root, `browser-${width}.png`);
    const bytes = await readFile(screenshot);
    assert.ok(bytes.length > 10000);
    assert.equal(bytes.readUInt32BE(16), width);
    await cp(screenshot, `${process.env.VS_OMP_LIVE_REPORT}.${width}.png`);
  }
  await assert.rejects(fetch(result.url, { signal: AbortSignal.timeout(2000) }));
  assert.equal(api.status()!.changes.length, 0);
  console.log(
    'PASS: real-model managed preview, Node-compatible Playwright, mobile/desktop interaction, screenshots and server cleanup.',
  );
}

export async function ownedBrowserWorkflow(api: Api, _root: string, prompt: Prompt): Promise<void> {
  const canary = `Owned Live ${randomUUID().slice(0, 8)}`;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Owned Live Browser</title><h1>Owned browser form</h1><label>Name <input id="name"></label><button id="save">Save</button><p id="result">Waiting</p><script>document.getElementById("save").onclick=()=>{document.getElementById("result").textContent="Saved: "+document.getElementById("name").value};console.log("owned live ready")</script>',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const config = vscode.workspace.getConfiguration('omp');
  await config.update(
    'browser.executablePath',
    process.env.VS_OMP_LIVE_BROWSER_PATH || '/opt/brave.com/brave/brave',
    vscode.ConfigurationTarget.Global,
  );
  const approve = (approval: PendingApproval) => ownedConsent(approval, url, canary);
  try {
    await prompt(
      `Use only the browser tool, no shell/scripts/files/todos. Open ${url} as a fresh OMP-owned page and read it. Fill its Name input (#name) with exactly ${JSON.stringify(canary)}, click Save (#save), and read the resulting confirmation. Capture an actual screenshot at width 420 and height 800, then at width 1100 and height 800. Inspect console output and close the page. Report the exact saved confirmation and briefly describe the two images. Do not retry failed actions or access any other address.`,
      approve,
    );
    const text = await prompt(
      'Use browser pages to check whether any page survived the previous prompt. Do not open anything. Report the owned page count.',
      () => false,
    );
    assert.match(text, /0|zero|no (?:owned )?pages/i);
    const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
    const browserCalls = report.tools.filter((entry: { name: string }) => entry.name === 'browser');
    for (const action of [
      'open',
      'read',
      'fill',
      'click',
      'viewport',
      'screenshot',
      'console',
      'close',
      'pages',
    ])
      assert.ok(
        browserCalls.some((entry: { input: string }) => JSON.parse(entry.input).action === action),
        `Missing actual ${action}`,
      );
    assert.ok(
      report.results.some(
        (entry: { name: string; content: string; isError: boolean }) =>
          entry.name === 'browser' && !entry.isError && entry.content.includes(`Saved: ${canary}`),
      ),
    );
    assert.ok(
      report.results.filter(
        (entry: { name: string; imageCount: number }) =>
          entry.name === 'browser' && entry.imageCount > 0,
      ).length >= 2,
    );
    assert.equal(api.status()!.changes.length, 0);
    console.log(
      'PASS: genuine model-owned browser form, two actual images, console and prompt-lifetime cleanup.',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await config.update('browser.executablePath', undefined, vscode.ConfigurationTarget.Global);
  }
}

function ownedConsent(approval: PendingApproval, url: string, canary: string): boolean {
  if (approval.title !== 'Allow Owned Browser Action?') return false;
  const input = browserRequest.parse(JSON.parse(approval.details).request);
  switch (input.action) {
    case 'open':
      return input.url === url;
    case 'fill':
      return input.selector === '#name' && input.text === canary;
    case 'click':
      return input.selector === '#save';
    case 'viewport':
      return [420, 1100].includes(input.width) && input.height === 800;
    default:
      return false;
  }
}
