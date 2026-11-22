import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { appendFile, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PendingApproval } from '../approvals.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (
  text: string,
  approve: (approval: PendingApproval) => boolean,
  expectedError?: boolean,
) => Promise<string>;
type Report = {
  requests: { at: number }[];
  tools: { name: string; input: string }[];
  results: { content: string; isError: boolean }[];
  processStarts: number;
};

const reportFile = () => process.env.VS_OMP_LIVE_REPORT!;
const report = async (): Promise<Report> => JSON.parse(await readFile(reportFile(), 'utf8'));

async function initialReport(): Promise<Report> {
  try {
    return await report();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { requests: [], tools: [], results: [], processStarts: 0 };
  }
}

async function waitText(
  file: string,
  accepts: (text: string) => boolean,
  signal: AbortSignal,
): Promise<string> {
  let watcher: ReturnType<typeof watch>;
  let abort = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const inspect = () => {
        void readFile(file, 'utf8')
          .then((text) => {
            if (accepts(text)) resolve(text);
          })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') reject(error);
          });
      };
      watcher = watch(path.dirname(file), (_event, name) => {
        if (name === path.basename(file)) inspect();
      });
      watcher.once('error', reject);
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      signal.throwIfAborted();
      inspect();
    });
  } finally {
    watcher!?.close();
    signal.removeEventListener('abort', abort);
  }
}

async function authFixture(failed: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-live-terminal-'));
  await chmod(directory, 0o700);
  const expected = `SYNTHETIC_${randomUUID()}`;
  const value = failed ? `SYNTHETIC_${randomUUID()}` : expected;
  const expectedFile = path.join(directory, 'expected');
  const finished = path.join(directory, 'finished');
  const script = path.join(directory, 'mock-auth.sh');
  await writeFile(expectedFile, expected, { mode: 0o600 });
  await writeFile(
    script,
    [
      'printf READY',
      'IFS= read -rs value',
      'printf \'%s\' "$value"',
      `test "$value" = "$(cat ${JSON.stringify(expectedFile)})"`,
      'status=$?',
      `printf finished > ${JSON.stringify(finished)}`,
      'exit "$status"',
    ].join('\n'),
    { mode: 0o600 },
  );
  return {
    directory,
    finished,
    value,
    command: `/bin/bash --noprofile --norc ${JSON.stringify(script)}`,
  };
}

function instructions(command: string) {
  return (
    'Use only bash for this local synthetic human hand-off. Do not read or inspect the script or any files. ' +
    `Start exactly ${JSON.stringify(command)} with action start, pty true, visibility background. ` +
    'Then run exactly "printf OTHER_SAFE_WORK" as an ordinary hidden pipe command. ' +
    'Next use action takeover with the ACTUAL returned start jobId. A human will type directly in that terminal and confirm Resume Agent; never request or send input yourself. ' +
    'Await the takeover result without output/status polling. Then use action wait ONCE for that same jobId and action stop ONCE for cleanup, even after a nonzero outcome. ' +
    'For takeover/wait/stop include only action and jobId, no other keys even null. Do not retry or create another command. ' +
    'Finally report the actual numeric exit code and success or failure, not the hidden input.'
  );
}

function stageResults(state: Report, before: Report, failed: boolean) {
  const calls = state.tools.slice(before.tools.length);
  assert.ok(calls.every((call) => call.name === 'bash'));
  const requests = calls.map((call) => JSON.parse(call.input));
  assert.deepEqual(
    requests.map((request) => request.action ?? 'run'),
    ['start', 'run', 'takeover', 'wait', 'stop'],
  );
  assert.equal(requests[0].pty, true);
  assert.equal(requests[0].visibility, 'background');
  assert.equal(requests[1].pty ?? false, false);
  assert.equal(requests[1].visibility ?? 'hidden', 'hidden');
  const results = state.results.slice(before.results.length).map((entry) => {
    const blocks = JSON.parse(entry.content);
    return {
      ...JSON.parse(blocks.find((block: { type: string }) => block.type === 'text').text),
      isError: entry.isError,
    };
  });
  assert.equal(results.length, 5);
  assert.equal(results[1].output.trim(), 'OTHER_SAFE_WORK');
  for (const index of [2, 3]) {
    assert.equal(requests[index].jobId, results[0].jobId);
    assert.equal(results[index].output, '');
    assert.equal(results[index]._meta['vs-omp/capture'], 'withheld-after-takeover');
    assert.equal(results[index].exitStatus.exitCode, failed ? 1 : 0);
    assert.equal(results[index].isError, failed);
  }
  assert.equal(requests[4].jobId, results[0].jobId);
  return results[0].jobId as string;
}

export async function assertTerminalPrivacy(file: string, value: string, snapshots: unknown[]) {
  assert.equal((await readFile(file, 'utf8')).includes(value), false);
  let wire = '';
  try {
    wire = await readFile(`${file}.wire.jsonl`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.equal(wire.includes(value), false);
  assert.equal(JSON.stringify(snapshots).includes(value), false);
}

export async function assertNativeTerminalPrivacy(userData: string, value: string, jobId: string) {
  const root = path.join(userData, 'User', 'workspaceStorage');
  const workspaces = await readdir(root, { withFileTypes: true });
  const directories = workspaces
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name, 'vs-omp-local.vs-omp', 'omp-sessions'));
  let persisted = false;
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.jsonl')) continue;
      assert.ok(entry.isFile(), 'Native transcript must not be a symlink or special file.');
      const text = await readFile(path.join(directory, entry.name), 'utf8');
      assert.equal(text.includes(value), false);
      persisted ||= text.includes(jobId);
    }
  }
  assert.ok(persisted, 'The actual job ID must exist in the checked native transcripts.');
}

async function humanHold(
  prefix: string,
  fixture: Awaited<ReturnType<typeof authFixture>>,
  label: string,
  held: Report,
  settled: () => boolean,
  signal: AbortSignal,
) {
  assert.match(label, /^OMP [a-f0-9]{8}$/);
  await writeFile(
    `${prefix}-ready.json`,
    JSON.stringify({
      terminal: label,
      value: fixture.value,
      requests: held.requests.length,
    }),
    { mode: 0o600 },
  );
  await waitText(fixture.finished, () => true, signal);
  const current = await report();
  assert.equal(current.requests.length, held.requests.length);
  assert.equal(current.results.length, held.results.length);
  assert.equal(settled(), false);
  await writeFile(`${prefix}-finished`, 'finished', { mode: 0o600 });
}

async function completedStage(
  api: Api,
  value: string,
  before: Report,
  held: Report,
  index: number,
  answer: string,
  approvals: number,
) {
  const failed = index === 1;
  const after = await report();
  assert.ok(after.requests.length > held.requests.length, 'Confirmation needs fresh generation.');
  assert.equal(approvals, 2);
  const jobId = stageResults(after, before, failed);
  await assertTerminalPrivacy(reportFile(), value, [api.status(), api.storedState!()]);
  const userData = process.env.VS_OMP_LIVE_USER_DATA;
  assert.ok(userData, 'The live fixture must identify its own disposable profile.');
  await assertNativeTerminalPrivacy(userData, value, jobId);
  assert.match(
    answer,
    failed ? /fail|exit(?:\s+code)?\s*1/i : /success|succeed|complet|exit(?:\s+code)?\s*0/i,
  );
  await appendFile(
    `${reportFile()}.terminal-handoff.jsonl`,
    JSON.stringify({
      index,
      failed,
      passed: true,
      requestsDuringHold: 0,
      requests: after.requests.length - before.requests.length,
      tools: 5,
      exitCode: failed ? 1 : 0,
    }) + '\n',
    { mode: 0o600 },
  );
}

async function handoffCase(api: Api, root: string, prompt: Prompt, index: number) {
  const failed = index === 1;
  const fixture = await authFixture(failed);
  const prefix = path.join(root, `live-terminal-${index}`);
  const signal = AbortSignal.timeout(Number(process.env.VS_OMP_LIVE_SECONDS) * 1000);
  const before = await initialReport();
  const approved: string[] = [];
  const labels: string[] = [];
  const opened = vscode.window.onDidOpenTerminal((terminal) => {
    if (/^OMP [a-f0-9]{8}$/.test(terminal.name)) labels.push(terminal.name);
  });
  let running: Promise<string> | undefined;
  let settled = false;
  try {
    running = prompt(
      instructions(fixture.command),
      (approval) => {
        const allow =
          approval.kind === 'command' &&
          approval.cwd === root &&
          [fixture.command, 'printf OTHER_SAFE_WORK'].includes(approval.summary) &&
          !approved.includes(approval.summary);
        if (allow) approved.push(approval.summary);
        return allow;
      },
      failed,
    ).finally(() => {
      settled = true;
    });
    void running.catch(() => {});
    const heldText = await Promise.race([
      waitText(
        reportFile(),
        (text) =>
          (JSON.parse(text) as Report).tools
            .slice(before.tools.length)
            .some((call) => JSON.parse(call.input).action === 'takeover'),
        signal,
      ),
      running.then(() => {
        throw new Error('Model ended without a takeover hold.');
      }),
    ]);
    const held = JSON.parse(heldText) as Report;
    assert.equal(held.results.length, before.results.length + 2);
    assert.equal(labels.length, 1, 'Only the requested PTY may open an integrated terminal.');
    await humanHold(prefix, fixture, labels[0]!, held, () => settled, signal);
    await completedStage(api, fixture.value, before, held, index, await running, approved.length);
  } finally {
    if (api.status()!.busy) await api.request!({ v: 1, type: 'cancel' });
    await running?.catch(() => {});
    opened.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(`${prefix}-ready.json`, { force: true });
    await rm(`${prefix}-finished`, { force: true });
  }
}

export async function terminalWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  const sessionId = api.status()!.sessionId!;
  await handoffCase(api, root, prompt, 0);
  await api.request!({ v: 1, type: 'disconnect' });
  await api.resume!(sessionId);
  await handoffCase(api, root, prompt, 1);
  assert.ok((await report()).processStarts >= 2, 'One cumulative budget must cover OMP restart.');
  assert.equal(api.status()!.changes.length, 0);
  console.log(
    'PASS: genuine model selects owned PTY/handoff, stays silent while held, resumes fresh and reports real failure across restart.',
  );
}
