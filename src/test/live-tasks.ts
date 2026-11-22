import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PendingApproval } from '../approvals.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (text: string, approve: (approval: PendingApproval) => boolean) => Promise<string>;
const source = 'parity-task-workflow';
const check = 'await import("./task-check.mjs")';
const wait = 'await import("./task-wait.mjs")';
const graphCheck = 'await import("./task-graph-check.mjs")';
const graphWatch = 'await import("./task-graph-watch.mjs")';

export function approveTask(root: string, approval: PendingApproval): boolean {
  if (approval.kind !== 'command') return false;
  const field = (name: string) => {
    const text = approval.details.split('\n\n').find((entry) => entry.startsWith(`${name}: `));
    return text ? JSON.parse(text.slice(name.length + 2)) : undefined;
  };
  return (
    field('Executable') === process.execPath &&
    field('Working directory') === root &&
    JSON.stringify(field('Environment overrides')) ===
      JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }) &&
    [check, wait, graphCheck, graphWatch].some(
      (command) =>
        JSON.stringify(field('Arguments')) ===
        JSON.stringify(['--input-type=module', '-e', command]),
    )
  );
}

export async function taskWorkflowFixtures(root: string, graph = false) {
  const before =
    'export function taskQuote(weight: number): number { return Math.floor(weight) * 7; }\n';
  await writeFile(path.join(root, 'src/task-feature.ts'), before);
  await writeFile(
    path.join(root, 'task-check.mjs'),
    'import assert from "node:assert/strict";\nimport {taskQuote} from "./src/task-feature.ts";\nassert.equal(taskQuote(1.2),14);\nassert.equal(taskQuote(0),0);\nconsole.log("TASK_WORKFLOW_PASSED");\n',
  );
  await writeFile(
    path.join(root, 'task-wait.mjs'),
    'import fs from "node:fs";\nfs.writeFileSync("task-ready.tmp",String(process.pid));\nfs.renameSync("task-ready.tmp","task-ready.txt");\nsetInterval(()=>{},1000);\n',
  );
  if (graph) {
    await writeFile(
      path.join(root, 'task-graph-watch.mjs'),
      'import fs from "node:fs";fs.writeFileSync("task-watch-pid.txt",String(process.pid));console.log("GRAPH_READY");setInterval(()=>{},1000);\n',
    );
    await writeFile(
      path.join(root, 'task-graph-check.mjs'),
      'import assert from "node:assert/strict";import fs from "node:fs";import {taskQuote} from "./src/task-feature.ts";process.kill(Number(fs.readFileSync("task-watch-pid.txt","utf8")),0);try{assert.equal(taskQuote(1.2),14);assert.equal(taskQuote(0),0);console.log("TASK_WORKFLOW_PASSED");}catch(error){console.error(JSON.stringify({path:"src/task-feature.ts",line:1,column:1,message:error.message}));throw error;}\n',
    );
  }
  const definitions = graph
    ? [
        ['Task graph check', graphCheck],
        ['Task graph watch', graphWatch],
        ['Task graph wait', wait],
      ]
    : [
        ['Task workflow check', check],
        ['Task workflow wait', wait],
      ];
  const provider = vscode.tasks.registerTaskProvider(source, {
    provideTasks: () =>
      definitions.map(([name, command]) => {
        const task = new vscode.Task(
          { type: source, name },
          vscode.workspace.workspaceFolders![0]!,
          name!,
          source,
          new vscode.ProcessExecution(process.execPath, ['--input-type=module', '-e', command!], {
            cwd: root,
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }),
        );
        task.isBackground = name === 'Task graph watch';
        return task;
      }),
    resolveTask: () => undefined,
  });
  return { before, provider };
}

async function stopTask(api: Api, root: string, graph = false): Promise<void> {
  let ready!: () => void;
  let expire!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    expire = reject;
  });
  const watcher = watch(root, (_event, fileName) => {
    if (fileName === 'task-ready.txt') ready();
  });
  const timer = setTimeout(() => expire(new Error('Actual model task did not start')), 45000);
  const handled = new Set<string>();
  const approvals = setInterval(() => {
    const approval = api.status()!.approval;
    if (!approval || handled.has(approval.id)) return;
    handled.add(approval.id);
    void api.request!({
      v: 1,
      type: 'approval',
      id: approval.id,
      decision: approveTask(root, approval) ? 'allow' : 'skip',
    });
  }, 20);
  let settled = false;
  const running = api.request!({
    v: 1,
    type: 'prompt',
    text: graph
      ? `Use only task. ${graphInput('Task graph wait')} It will be stopped by me after the dependent starts. Do not retry, detach, edit files or run shell commands.`
      : `Use only task. Run foreground task "Task workflow wait" from source "${source}" without a timeout. It will be stopped by me after startup. Do not retry, detach, edit files or run shell commands.`,
  }).finally(() => {
    settled = true;
  });
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error('Task prompt ended before Stop');
      }),
    ]);
    const pid = Number(await readFile(path.join(root, 'task-ready.txt'), 'utf8'));
    assert.ok(pid > 0);
    const requests = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8')).requests
      .length;
    await api.request!({ v: 1, type: 'cancel' });
    await running;
    assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(api.status()!.changes.length, 0);
    assert.equal(handled.size, graph ? 2 : 1);
    if (graph) {
      assert.equal(
        JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8')).requests.length,
        requests,
      );
      await graphWorkerGone(root);
    }
  } finally {
    clearTimeout(timer);
    clearInterval(approvals);
    watcher.close();
    if (!settled) await api.request!({ v: 1, type: 'cancel' });
    await running;
  }
}

export function assertTaskEvidence(
  report: {
    tools: { name: string; input: string }[];
    results: { name: string; isError: boolean; content: string }[];
  },
  start = { tools: 0, results: 0 },
  scope: 'complete' | 'review' = 'complete',
): void {
  const tools = report.tools.slice(start.tools);
  const results = report.results.slice(start.results);
  assert.ok(
    tools.every((entry: { name: string }) =>
      ['read', 'editor', 'edit', 'task'].includes(entry.name),
    ),
  );
  assert.equal(
    tools.filter((entry: { name: string }) => entry.name === 'task').length,
    scope === 'complete' ? 5 : 3,
  );
  const completed = results
    .filter((entry: { name: string; isError: boolean }) => entry.name === 'task' && !entry.isError)
    .map((entry: { content: string }) => JSON.parse(JSON.parse(entry.content)[0].text));
  assert.deepEqual(
    completed.map((entry: { exitStatus: { exitCode: number } }) => entry.exitStatus.exitCode),
    scope === 'complete' ? [1, 0, 1, 1] : [1, 0, 1],
  );
  assert.ok(completed[1].output.includes('TASK_WORKFLOW_PASSED'));
  assert.ok(
    tools.some(
      (entry: { name: string; input: string }) =>
        entry.name === 'editor' && JSON.parse(entry.input).action === 'tasks',
    ),
  );
  const errors = results.filter((entry: { isError: boolean }) => entry.isError);
  if (scope === 'review') assert.equal(errors.length, 0);
  else
    assert.ok(
      errors.every(
        (entry: { name: string; content: string }) =>
          entry.name === 'task' && /cancel|abort|stop/i.test(entry.content),
      ),
    );
}

async function reviewedTaskTurns(
  api: Api,
  root: string,
  ask: (text: string) => Promise<string>,
  before: string,
) {
  await ask(
    'List workspace tasks using editor tasks. Report the two task workflow names, source and execution kind. Do not execute or edit anything yet.',
  );
  await ask(
    `Read src/task-feature.ts and task-check.mjs, then use task to run "Task workflow check" from source "${source}" exactly once without a timeout. Report the actual exit status and assertion failure; do not repair or retry yet.`,
  );
  await ask(
    `Repair only src/task-feature.ts through edit: taskQuote must charge 7 per weight unit rounded up. Run "Task workflow check" from "${source}" exactly once with task and report its actual result. Leave the source edit in review.`,
  );
  assert.match(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), /Math\.ceil/);
  assert.equal(api.status()!.changes.length, 1);
  for (const change of api.status()!.changes)
    await api.request!({ v: 1, type: 'discard', id: change.id });
  assert.equal(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), before);
  await ask(
    `I discarded the source edit. Reread src/task-feature.ts now, then run "Task workflow check" from "${source}" once with task. Report its actual restored failure, not the earlier passing result. Do not repair or retry.`,
  );
}

export async function taskEvidenceStart(file: string): Promise<{ tools: number; results: number }> {
  try {
    const report = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Array.isArray(report.tools) && Array.isArray(report.results));
    return { tools: report.tools.length, results: report.results.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { tools: 0, results: 0 };
  }
}

async function runTaskWorkflow(
  api: Api,
  root: string,
  prompt: Prompt,
  scope: 'complete' | 'review',
) {
  const start = await taskEvidenceStart(process.env.VS_OMP_LIVE_REPORT!);
  const fixture = await taskWorkflowFixtures(root);
  const ask = (text: string) =>
    prompt(
      'Use only read, editor, edit and task. No bash, writes, todos, task creation or other tools. ' +
        text,
      (approval) => approveTask(root, approval),
    );
  try {
    await reviewedTaskTurns(api, root, ask, fixture.before);
    if (scope === 'complete') {
      await stopTask(api, root);
      await ask(
        `After Stop, reread src/task-feature.ts from disk and run "Task workflow check" from "${source}" exactly once again. Report its actual exit code and current rounding. Do not repair or retry.`,
      );
    }
    assert.equal(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), fixture.before);
    assert.equal(api.status()!.changes.length, 0);
    assertTaskEvidence(
      JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8')),
      start,
      scope,
    );
    console.log(
      scope === 'review'
        ? 'PASS: four-turn genuine task discovery, actual failure, reviewed repair, passing rerun, Discard and fresh restored failure.'
        : 'PASS: six-turn genuine-model task discovery, failing test, reviewed repair, successful rerun, Discard, fresh failure, owned-process Stop and recovery.',
    );
  } finally {
    fixture.provider.dispose();
  }
}

export async function taskWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  await runTaskWorkflow(api, root, prompt, 'complete');
}

export async function taskReviewWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  await runTaskWorkflow(api, root, prompt, 'review');
}

function graphInput(name: string): string {
  return `Run task exactly once with input ${JSON.stringify({
    name,
    source,
    graph: [
      {
        id: 'watch',
        name: 'Task graph watch',
        source,
        dependsOn: [],
        readiness: { line: 'GRAPH_READY' },
      },
      { id: 'final', name, source, dependsOn: ['watch'], readiness: null },
    ],
  })}. Do not add readiness to the foreground final or use a timeout.`;
}

async function graphWorkerGone(root: string): Promise<void> {
  const pid = Number(await readFile(path.join(root, 'task-watch-pid.txt'), 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

function graphEvidence(
  report: Parameters<typeof assertTaskEvidence>[0],
  start: { tools: number; results: number },
): void {
  const tools = report.tools.slice(start.tools);
  const results = report.results.slice(start.results);
  assert.ok(tools.every((entry) => ['read', 'editor', 'edit', 'task'].includes(entry.name)));
  assert.equal(tools.filter((entry) => entry.name === 'task').length, 5);
  assert.ok(
    tools.some((entry) => entry.name === 'editor' && JSON.parse(entry.input).action === 'tasks'),
  );
  const completed = results
    .filter((entry) => entry.name === 'task' && !entry.isError)
    .map((entry) => JSON.parse(JSON.parse(entry.content)[0].text));
  assert.deepEqual(
    completed.map((entry) => entry.status),
    ['failed', 'passed', 'failed', 'failed'],
  );
  for (const entry of completed) {
    assert.equal(entry.graph, 'OMP-owned');
    assert.equal(entry.results[0].readiness, 'ready');
    assert.ok(entry.results[0].cleanup);
    assert.equal(entry.results[1].exitStatus.exitCode, entry.status === 'passed' ? 0 : 1);
    assert.equal(entry.diagnostics.items.length, entry.status === 'passed' ? 0 : 1);
  }
  assert.match(completed[1].results[1].output, /TASK_WORKFLOW_PASSED/);
  const errors = results.filter((entry) => entry.isError);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.name, 'task');
  assert.match(errors[0]!.content, /Interrupted by user/);
}

export async function taskGraphWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  const start = await taskEvidenceStart(process.env.VS_OMP_LIVE_REPORT!);
  const fixture = await taskWorkflowFixtures(root, true);
  const ask = (text: string) =>
    prompt(
      'Use only read, editor, edit and task. No bash, writes, todos, task creation or other tools. ' +
        text,
      (approval) => approveTask(root, approval),
    );
  try {
    await ask(
      'List workspace tasks using editor tasks. Report the graph task names and background limitation; do not execute yet.',
    );
    await ask(
      `Read src/task-feature.ts and task-graph-check.mjs. ${graphInput('Task graph check')} Report actual graph failure and diagnostic; do not repair yet.`,
    );
    await graphWorkerGone(root);
    await ask(
      `Repair only src/task-feature.ts through edit: taskQuote charges 7 per unit rounded up. ${graphInput('Task graph check')} Leave the source edit in review.`,
    );
    await graphWorkerGone(root);
    assert.match(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), /Math\.ceil/);
    assert.equal(api.status()!.changes.length, 1);
    await api.request!({ v: 1, type: 'discard', id: api.status()!.changes[0]!.id });
    assert.equal(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), fixture.before);
    await ask(
      `I discarded the edit. Reread src/task-feature.ts now. ${graphInput('Task graph check')} Report its current failure; do not repair or retry.`,
    );
    await graphWorkerGone(root);
    await stopTask(api, root, true);
    await ask(
      `After Stop, reread src/task-feature.ts from disk. ${graphInput('Task graph check')} Report current rounding and actual result; do not repair or retry.`,
    );
    await graphWorkerGone(root);
    assert.equal(await readFile(path.join(root, 'src/task-feature.ts'), 'utf8'), fixture.before);
    assert.equal(api.status()!.changes.length, 0);
    graphEvidence(JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8')), start);
    console.log(
      'PASS: genuine-model graph discovery, declared readiness, failure diagnostics, reviewed repair, Discard/fresh failure and two-process Stop/recovery.',
    );
  } finally {
    fixture.provider.dispose();
  }
}
