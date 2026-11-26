import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { PendingApproval } from '../approvals.js';
import { browserWorkflow, ownedBrowserWorkflow } from './live-browser.js';
import {
  editorWorkflow,
  resourceWorkflow,
  renameWorkflow,
  notebookImageWorkflow,
} from './live-editor.js';
import { mixedQuestionWorkflow, questionWorkflow } from './live-questions.js';
import { taskWorkflow, taskGraphWorkflow } from './live-tasks.js';
import { webWorkflow } from './live-web.js';
import { codeActionWorkflow, retrievalRefactorWorkflow } from './live-code-actions.js';
import { sessionBrowserWorkflow } from './live-browser-session.js';
import { workspaceSymbolWorkflow } from './live-workspace-symbols.js';
import { notebookWorkflow } from './live-notebook.js';
import { imageContextWorkflow, imageFormatWorkflow } from './live-image-context.js';
import { terminalWorkflow } from './live-terminals.js';
import {
  mixedSessionWorkflow,
  mixedHistoryWorkflow,
  seedWorkspaceInstructions,
  workspaceInstructionWorkflow,
} from './live-mixed-session.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type ApproveCommand = (approval: PendingApproval) => boolean | undefined;

const workflows = new Map([
  [
    'retrieval-refactor',
    {
      run: retrievalRefactorWorkflow,
      name: 'semantic-discovery-cross-file-refactor-discard-keep-stop',
    },
  ],
  [
    'instructions',
    { run: workspaceInstructionWorkflow, name: 'root-instruction-capture-resume-and-authority' },
  ],
  [
    'mixed-session',
    { run: mixedSessionWorkflow, name: 'five-turn-questions-task-review-discard-fresh-failure' },
  ],
  [
    'mixed-history',
    { run: mixedHistoryWorkflow, name: 'context-replay-generated-compaction-resume-keep-refusal' },
  ],
  [
    'terminal-handoff',
    { run: terminalWorkflow, name: 'two-stage-pty-human-handoff-restart-failure' },
  ],
  [
    'image-context',
    { run: imageContextWorkflow, name: 'four-generation-mixed-image-text-remove-replay-reopen' },
  ],
  ['image-formats', { run: imageFormatWorkflow, name: 'jpeg-webp-exact-pixels-no-tools' }],
  [
    'notebook-review',
    { run: notebookWorkflow, name: 'five-turn-notebook-source-review-discard-keep' },
  ],
  [
    'workspace-symbols',
    {
      run: workspaceSymbolWorkflow,
      name: 'three-turn-workspace-symbol-reference-fresh-source-empty-provider',
    },
  ],
  [
    'browser-session',
    { run: sessionBrowserWorkflow, name: 'five-turn-session-browser-retain-revoke-fresh-stop' },
  ],
  [
    'code-actions',
    {
      run: codeActionWorkflow,
      name: 'five-turn-reviewed-provider-action-discard-keep-fresh-availability',
    },
  ],
  [
    'web-tasks',
    { run: webWorkflow, name: 'seven-turn-web-task-repair-discard-refusal-stop-recovery' },
  ],
  ['tasks', { run: taskWorkflow, name: 'six-turn-native-task-repair-discard-stop-and-recovery' }],
  [
    'task-graphs',
    {
      run: taskGraphWorkflow,
      name: 'six-turn-readiness-graph-diagnostics-review-discard-stop-recovery',
    },
  ],
  [
    'notebook-images',
    { run: notebookImageWorkflow, name: 'notebook-images-pixel-identifiers-and-distinct-charts' },
  ],
  ['rename', { run: renameWorkflow, name: 'reviewed-cross-file-semantic-rename-discard-and-keep' }],
  ['resources', { run: resourceWorkflow, name: 'live-notebook-output-tasks-and-unsaved-reread' }],
  ['browser', { run: browserWorkflow, name: 'managed-preview-and-playwright' }],
  ['owned-browser', { run: ownedBrowserWorkflow, name: 'owned-browser-generated-form-and-images' }],
  ['editor', { run: editorWorkflow, name: 'six-turn-editor-repair-review-workflow' }],
  ['questions', { run: questionWorkflow, name: 'six-turn-native-questions-and-search' }],
  [
    'mixed-questions',
    { run: mixedQuestionWorkflow, name: 'one-turn-in-chat-mixed-question-exact-once' },
  ],
]);

function approvalDecision(
  approval: PendingApproval,
  reads?: ReadonlySet<string>,
  command?: ApproveCommand,
) {
  if (approval.kind === 'file') return Boolean(reads?.has(approval.summary));
  return command ? command(approval) : false;
}

async function prompt(
  api: Api,
  text: string,
  rejected: boolean | PendingApproval['kind'] = false,
  approvedReads?: ReadonlySet<string>,
  approveCommand?: ApproveCommand,
) {
  const request = (message: object) => api.request!({ v: 1, ...message });
  const handled = new Set<string>();
  const granted = new Set<string>();
  const refusedKinds = new Set<PendingApproval['kind']>();
  const timer = setInterval(() => {
    const approval = api.status()!.approval;
    if (!approval || handled.has(approval.id)) return;
    const allow = approvalDecision(approval, approvedReads, approveCommand);
    if (allow === undefined) return;
    handled.add(approval.id);
    if (allow && approval.kind === 'file') granted.add(approval.summary);
    if (!allow) refusedKinds.add(approval.kind);
    void request({ type: 'approval', id: approval.id, decision: allow ? 'allow' : 'skip' });
  }, 20);
  try {
    await request({ type: 'prompt', text });
    const status = api.status()!;
    assert.equal(status.error, '');
    const turn = status.turns.at(-1)!;
    assert.equal(
      turn.status,
      'completed',
      'Live turn did not complete; provider content withheld.',
    );
    if (approvedReads) assert.deepEqual(granted, approvedReads);
    if (rejected) {
      assert.ok(handled.size > 0, 'The actual host approval must be refused.');
      if (typeof rejected === 'string') assert.deepEqual([...refusedKinds], [rejected]);
    } else
      assert.ok(
        !turn.blocks.some((block) => block.kind === 'tool' && block.status === 'failed'),
        'Live tool failed; provider content withheld.',
      );
    return turn.blocks
      .filter((block) => block.kind === 'text')
      .map((block) => block.text)
      .join('\n');
  } finally {
    clearInterval(timer);
  }
}

async function seed(root: vscode.Uri) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'src', 'nested'));
  const files = {
    'README.md':
      '# ParcelMeter\nParcel shipping quote calculator. Source: src/nested/rates.ts.\nThe rate is 7 credits per rounded-up weight unit.\n',
    'src/nested/rates.ts':
      'export const rate = 7;\nexport function quote(weight: number) {\n  return Math.ceil(weight) * rate;\n}\n',
    'src/nested/rates.policy': 'Billing uses whole rounded-up weight units.\n',
    'scratch.md': 'UNRELATED_USER_WORK\n',
  };
  for (const [file, text] of Object.entries(files))
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, file), Buffer.from(text));
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'scratch.md'));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(0), 'UNSAVED_');
  assert.ok(await vscode.workspace.applyEdit(edit));
  return { files, document, dirty: document.getText() };
}

async function editing(api: Api, root: vscode.Uri) {
  await prompt(
    api,
    'Change the shipping rate from 7 to 9 credits in the source file. Leave unrelated files alone.',
  );
  assert.match(
    await readFile(vscode.Uri.joinPath(root, 'src/nested/rates.ts').fsPath, 'utf8'),
    /rate\s*=\s*9\b/,
  );
  await prompt(api, 'Now update the README to match the new shipping rate.');
  assert.match(await readFile(vscode.Uri.joinPath(root, 'README.md').fsPath, 'utf8'), /9 credits/);
  const changes = api.status()!.changes;
  assert.equal(changes.length, 2);
  for (const change of changes) await api.request!({ v: 1, type: 'discard', id: change.id });
  assert.equal(api.status()!.changes.length, 0);
}

async function stopAndRecover(api: Api) {
  const file = process.env.VS_OMP_LIVE_REPORT!;
  const before = JSON.parse(await readFile(file, 'utf8')).requests.length;
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const watcher = watch(path.dirname(file), () => {
    void readFile(file, 'utf8')
      .then((text) => {
        if (JSON.parse(text).requests.length > before) received();
      })
      .catch(() => {});
  });
  const timer = setTimeout(() => received(), 15_000);
  try {
    const running = api.request!({
      v: 1,
      type: 'prompt',
      text: 'Inspect the repository again and explain its implementation in detail.',
    });
    await started;
    assert.ok(
      JSON.parse(await readFile(file, 'utf8')).requests.length > before,
      'Stop must reach a real provider request.',
    );
    await api.request!({ v: 1, type: 'cancel' });
    await running;
    assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
    const resultCount = JSON.parse(await readFile(file, 'utf8')).results.length;
    assert.match(
      await prompt(
        api,
        'Read src/nested/rates.ts from disk again now and report the current rate. Do not rely on earlier conversation values. Answer briefly.',
      ),
      /7|seven/i,
    );
    const results: { content: string; isError: boolean }[] = JSON.parse(
      await readFile(file, 'utf8'),
    ).results.slice(resultCount);
    assert.ok(
      results.some((result) => !result.isError && /rate\s*=\s*7\b/.test(result.content)),
      'Recovery must obtain fresh source-file content, not answer from stale conversation history.',
    );
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

async function connect(model: string): Promise<Api> {
  const extension = vscode.extensions.getExtension<Api>('vs-omp-local.vs-omp');
  assert.ok(extension);
  const api = await extension.activate();
  await vscode.commands.executeCommand('omp.open');
  await vscode.workspace
    .getConfiguration('omp')
    .update('model', model, vscode.ConfigurationTarget.Global);
  await vscode.workspace
    .getConfiguration('omp')
    .update(
      'executablePath',
      process.env.VS_OMP_LIVE_EXECUTABLE!,
      vscode.ConfigurationTarget.Global,
    );
  await vscode.commands.executeCommand('omp.newSession');
  assert.equal(api.status()!.connected, true, api.status()!.error);
  const selected = api.status()!.configs.find((option) => option.id === 'model');
  assert.equal(selected?.value, model, 'Live tests never silently fall back to another model.');
  const thinking = api.status()!.configs.find((option) => option.id === 'thinking');
  if (thinking?.options?.some((option) => option.value === 'off'))
    await api.request!({ v: 1, type: 'config', id: 'thinking', value: 'off' });
  return api;
}

async function outsideReads(api: Api) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-outside-'));
  const target = path.join(directory, 'catalog.policy');
  const first = randomUUID();
  const second = randomUUID();
  try {
    await writeFile(target, `Catalog code: ${first}\n`);
    const text = await prompt(
      api,
      `Inspect the folder ${directory} and report the catalog code from the file inside. Do not change files.`,
      false,
      new Set([directory, target]),
    );
    assert.ok(text.includes(first));
    await writeFile(target, `Catalog code: ${second}\n`);
    const refused = await prompt(
      api,
      `Read ${target} again and report its current catalog code. If permission is refused, do not retry.`,
      true,
    );
    assert.ok(!refused.includes(second));
    assert.equal(await readFile(target, 'utf8'), `Catalog code: ${second}\n`);
    assert.equal(api.status()!.changes.length, 0);
    console.log(
      'PASS: real outside-directory and file approvals, then fresh read refusal without exposure or mutation.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordOutcome(model: string, scenarios: string[], api: Api) {
  const file = process.env.VS_OMP_LIVE_REPORT!;
  const report = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(report.refused.length, 0, JSON.stringify(report.refused));
  assert.ok(report.requests.length > 0);
  await writeFile(
    `${file}.chat.json`,
    JSON.stringify(
      api.status()!.turns.map((turn) => ({
        prompt: turn.prompt,
        status: turn.status,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        blocks: turn.blocks
          .filter((block) => block.kind !== 'thought')
          .map((block) => ({
            kind: block.kind,
            text: block.text.slice(0, 8192),
            status: block.status,
            title: block.title,
            toolKind: block.toolKind,
          })),
      })),
    ),
    { mode: 0o600 },
  );
  await writeFile(
    `${file}.outcomes.json`,
    JSON.stringify({
      model,
      passed: true,
      scenarios,
      requests: report.requests.length,
      tools: report.tools.length,
    }),
    { mode: 0o600 },
  );
}

export async function run(): Promise<void> {
  assert.equal(process.env.VS_OMP_LIVE_TESTS, '1');
  const model = process.env.VS_OMP_LIVE_MODEL!;
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const baseline = await seed(root);
  if (process.env.VS_OMP_LIVE_CASE === 'instructions') await seedWorkspaceInstructions(root.fsPath);
  const api = await connect(model);
  const workflow = workflows.get(process.env.VS_OMP_LIVE_CASE ?? '');
  if (workflow) {
    await workflow.run(api, root.fsPath, (text, approve, refused = false) =>
      prompt(api, text, refused, undefined, approve),
    );
    assert.equal(baseline.document.getText(), baseline.dirty);
    assert.equal(baseline.document.isDirty, true);
    assert.equal(
      await readFile(path.join(root.fsPath, 'scratch.md'), 'utf8'),
      baseline.files['scratch.md'],
    );
    await recordOutcome(model, [workflow.name], api);
    return;
  }
  if (process.env.VS_OMP_LIVE_CASE === 'outside') {
    await outsideReads(api);
    await recordOutcome(
      model,
      ['outside-directory-and-file-approval', 'fresh-outside-read-refusal'],
      api,
    );
    return;
  }
  if (process.env.VS_OMP_LIVE_CASE === 'shell') {
    await prompt(
      api,
      'Run the shell command `printf DECLINED > declined.txt`. If permission is declined, do not retry and report the refusal.',
      true,
    );
    await assert.rejects(readFile(path.join(root.fsPath, 'declined.txt')), /ENOENT/);
    console.log('PASS: focused real-model shell refusal.');
    await recordOutcome(model, ['shell-refusal'], api);
    return;
  }
  const readout = await prompt(
    api,
    'Please take a look over the given repository and give a readout on what it does and how it achieves it. Do not create a todo list for this small repository.',
  );
  assert.match(readout, /parcel.*(?:shipping|quote)|shipping.*calculator/i);
  assert.match(readout, /7|seven/i);
  assert.equal(api.status()!.changes.length, 0);
  if (process.env.VS_OMP_LIVE_CASE === 'readout') {
    assert.equal(baseline.document.getText(), baseline.dirty);
    assert.equal(baseline.document.isDirty, true);
    for (const [file, text] of Object.entries(baseline.files))
      assert.equal(await readFile(vscode.Uri.joinPath(root, file).fsPath, 'utf8'), text);
    await recordOutcome(model, ['repository-readout'], api);
    console.log(`PASS: real ${model} repository-readout canary.`);
    return;
  }
  await editing(api, root);
  await prompt(
    api,
    'Run the shell command `printf DECLINED > declined.txt`. If permission is declined, do not retry and report the refusal.',
    true,
  );
  await assert.rejects(readFile(path.join(root.fsPath, 'declined.txt')), /ENOENT/);
  await stopAndRecover(api);
  assert.equal(baseline.document.getText(), baseline.dirty);
  assert.equal(baseline.document.isDirty, true);
  for (const [file, text] of Object.entries(baseline.files))
    assert.equal(await readFile(vscode.Uri.joinPath(root, file).fsPath, 'utf8'), text);
  await recordOutcome(
    model,
    ['repository-readout', 'two-turn-edit-and-discard', 'shell-refusal', 'stop-and-recover'],
    api,
  );
  console.log(
    `PASS: live ${model}: repository readout, two-turn edit/Discard, shell refusal, unchanged unrelated dirty buffer.`,
  );
}
