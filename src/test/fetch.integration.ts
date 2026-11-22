import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Uri } from 'vscode';
import { fetchWeb } from '../host-fetch.js';
import { executeWorkspaceTask } from '../host-tasks.js';
import { TerminalManager } from '../terminal.js';
import { taskRequest } from '../task-policy.js';
import { taskWorkflowFixtures } from './live-tasks.js';
import { webWorkflowFixtures } from './live-web.js';

export async function nativeWebReads(root: Uri): Promise<void> {
  const requests: string[] = [];
  let streaming!: () => void;
  const started = new Promise<void>((resolve) => {
    streaming = resolve;
  });
  const server = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.referer, undefined);
    nativeResponse(request.url!, response, streaming);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const scope = { signal: AbortSignal.timeout(20000), valid: () => true };
  const approvals: string[] = [];
  const approve = async (request: { summary: string }) => {
    approvals.push(request.summary);
    return !request.summary.endsWith('/private');
  };
  try {
    const result = JSON.parse(await fetchWeb({ url: `${base}/redirect` }, scope, approve));
    assert.equal(result.status, 200);
    assert.equal(result.text, '<h1>NATIVE_WEB_DATA</h1>');
    assert.equal(result.untrusted, true);
    await assert.rejects(fetchWeb({ url: `${base}/refused` }, scope, approve), /not approved/);
    assert.ok(!requests.includes('/private'));
    assert.deepEqual(approvals, [
      `GET ${base}/redirect`,
      `GET ${base}/document`,
      `GET ${base}/refused`,
      `GET ${base}/private`,
    ]);
    const abort = new AbortController();
    const running = fetchWeb(
      { url: `${base}/stream` },
      { ...scope, signal: AbortSignal.any([scope.signal, abort.signal]) },
      approve,
    );
    const rejected = assert.rejects(running, /Stopped|abort/i);
    await started;
    abort.abort(new Error('Stopped'));
    await rejected;
    console.log(
      'PASS: native web GET uses per-URL consent, refuses redirected access before contact, omits identity headers and cancels streaming.',
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  await nativeWebTaskFixture(root.fsPath);
}

function nativeResponse(url: string, response: ServerResponse, streaming: () => void): void {
  if (url === '/redirect' || url === '/refused') {
    response.writeHead(302, { location: url === '/redirect' ? '/document' : '/private' });
    response.end();
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    if (url === '/stream') response.write('partial', streaming);
    else response.end('<h1>NATIVE_WEB_DATA</h1>');
  }
}

async function nativeWebTaskFixture(root: string): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  const web = await webWorkflowFixtures();
  const task = await taskWorkflowFixtures(root);
  const scope = {
    sessionId: 'native-web-tasks',
    cwd: root,
    privateRoot: path.join(root, '.task-private'),
    signal: AbortSignal.timeout(20000),
    valid: () => true,
  };
  const manager = new TerminalManager({
    ...scope,
    approve: async (command) => {
      assert.equal(command.command, process.execPath);
      assert.equal(command.cwd, root);
      assert.deepEqual(command.args, [
        '--input-type=module',
        '-e',
        'await import("./task-check.mjs")',
      ]);
      assert.deepEqual(command.env, { ELECTRON_RUN_AS_NODE: '1' });
      return true;
    },
  });
  try {
    const first = JSON.parse(
      await fetchWeb({ url: `${web.base}/redirect` }, scope, async (approval) =>
        web.approve({ ...approval, id: 'preflight' }),
      ),
    );
    assert.equal(JSON.parse(first.text).code, web.policy.code);
    web.policy.code = randomUUID();
    const second = JSON.parse(
      await fetchWeb({ url: `${web.base}/policy` }, scope, async (approval) =>
        web.approve({ ...approval, id: 'preflight' }),
      ),
    );
    assert.equal(JSON.parse(second.text).code, web.policy.code);
    const exits: number[] = [];
    for (const text of [task.before, task.before.replace('Math.floor', 'Math.ceil'), task.before]) {
      await writeFile(path.join(root, 'src/task-feature.ts'), text);
      const result = JSON.parse(
        await executeWorkspaceTask(
          taskRequest.parse({ name: 'Task workflow check', source: 'parity-task-workflow' }),
          scope,
          manager,
        ),
      );
      exits.push(result.exitStatus.exitCode);
    }
    assert.deepEqual(exits, [1, 0, 1]);
    assert.deepEqual(web.requests, ['/redirect', '/policy', '/policy']);
    console.log(
      'PASS: zero-inference mixed web/task fixture preflight uses fresh policy data and actual native task exits [1,0,1].',
    );
  } finally {
    await writeFile(path.join(root, 'src/task-feature.ts'), task.before);
    task.provider.dispose();
    await manager.dispose();
    await web.dispose();
  }
}
