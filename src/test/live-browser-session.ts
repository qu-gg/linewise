import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { PendingApproval } from '../approvals.js';
import { browserRequest } from '../browser-policy.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (text: string, approve: (approval: PendingApproval) => boolean) => Promise<string>;

export async function sessionBrowserFixture() {
  const canary = `Session ${randomUUID()}`;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Session Browser</title><h1>Session browser fixture</h1><label>Name <input id="name"></label><button id="save">Save</button><button id="disabled" disabled>Wait</button><p id="result">Waiting</p><script>document.getElementById("save").onclick=()=>{document.getElementById("result").textContent="Saved: "+document.getElementById("name").value};</script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  return {
    url,
    canary,
    approve(approval: PendingApproval): boolean {
      if (approval.title !== 'Allow Owned Browser Action?') return false;
      const request = browserRequest.parse(JSON.parse(approval.details).request);
      if (request.action === 'open') return request.url === url;
      if (request.action === 'fill') return request.selector === '#name' && request.text === canary;
      return request.action === 'click' && ['#save', '#disabled'].includes(request.selector);
    },
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function sessionBrowserWorkflow(
  api: Api,
  _root: string,
  prompt: Prompt,
): Promise<void> {
  const fixture = await sessionBrowserFixture();
  const config = vscode.workspace.getConfiguration('omp');
  const previous = config.inspect<string>('browser.executablePath')?.globalValue;
  await config.update(
    'browser.executablePath',
    process.env.VS_OMP_LIVE_BROWSER_PATH || '/opt/brave.com/brave/brave',
    vscode.ConfigurationTarget.Global,
  );
  try {
    await prompt(
      `Use only browser, no other tools. Open ${fixture.url}, read it, fill #name with exactly ${JSON.stringify(fixture.canary)}, click #save, and read the saved confirmation. Leave the page open for the next prompt. Do not retry failed actions.`,
      fixture.approve,
    );
    const retained = await prompt(
      'Use only browser. List the owned pages, read the same page from the previous prompt without navigating or reopening it, and capture its screenshot. Report the exact retained saved confirmation. Leave it open.',
      () => false,
    );
    assert.ok(retained.includes(fixture.canary));
    await vscode.commands.executeCommand('omp.closeBrowser');
    const revoked = await prompt(
      'The owner has revoked the owned browser using Close Owned Browser. Use only browser pages once, do not open anything, and report the current owned page count.',
      () => false,
    );
    assert.match(revoked, /0|zero|no (?:owned )?pages/i);
    await prompt(
      `Use only browser. Open ${fixture.url} once, read the fresh page and report whether it has the previous saved form state or the initial Waiting state. Leave it open. Do not fill or click.`,
      fixture.approve,
    );
    await vscode.commands.executeCommand('omp.stop');
    const stopped = await prompt(
      'The owner pressed Stop between prompts. Use only browser pages once, do not open anything, and report the current owned page count.',
      () => false,
    );
    assert.match(stopped, /0|zero|no (?:owned )?pages/i);
    await verifySessionObserver(api, fixture.canary);
    console.log(
      'PASS: five-turn genuine-model retained form/image, explicit browser revocation, fresh state and idle Stop cleanup.',
    );
  } finally {
    await vscode.commands.executeCommand('omp.closeBrowser');
    await config.update('browser.executablePath', previous, vscode.ConfigurationTarget.Global);
    await fixture.dispose();
  }
}

async function verifySessionObserver(api: Api, canary: string): Promise<void> {
  const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  assert.ok(report.tools.every((tool: { name: string }) => tool.name === 'browser'));
  assert.ok(report.results.every((result: { isError: boolean }) => !result.isError));
  const calls = report.tools.map((tool: { input: string }) =>
    browserRequest.parse(JSON.parse(tool.input)),
  );
  assert.equal(calls.filter((call: { action: string }) => call.action === 'open').length, 2);
  assert.equal(calls.filter((call: { action: string }) => call.action === 'pages').length, 3);
  assert.equal(calls.filter((call: { action: string }) => call.action === 'fill').length, 1);
  assert.equal(calls.filter((call: { action: string }) => call.action === 'click').length, 1);
  const results = report.results.map((entry: { content: string; imageCount: number }) => entry);
  assert.ok(
    results.filter((entry: { content: string }) => entry.content.includes(`Saved: ${canary}`))
      .length >= 2,
  );
  assert.equal(results.filter((entry: { imageCount: number }) => entry.imageCount > 0).length, 1);
  assert.equal(api.status()!.changes.length, 0);
}
