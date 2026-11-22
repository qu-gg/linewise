import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PendingApproval } from '../approvals.js';
import { fileSignal } from './production-terminal.integration.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (
  text: string,
  approve: (approval: PendingApproval) => boolean | undefined,
) => Promise<string>;

const mixedQuestions = [
  {
    header: 'Output',
    question: 'Choose output formats',
    multiSelect: true,
    options: [{ label: 'JSON' }, { label: 'Text' }],
    allowFreeformInput: true,
  },
  {
    header: 'Scope',
    question: 'Choose scope',
    multiSelect: false,
    options: [{ label: 'Small' }, { label: 'Large' }],
    allowFreeformInput: false,
  },
  { header: 'Notes', question: 'Supply the note', options: null, allowFreeformInput: true },
];

export async function mixedQuestionWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  const config = vscode.workspace.getConfiguration('omp');
  const previous = config.inspect<string>('notifications.focus')?.workspaceValue;
  const changes = structuredClone(api.storedState!().changes);
  const context = vscode.Uri.file(path.join(root, 'context-entry.ts'));
  try {
    await config.update('notifications.focus', 'always', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('omp.open');
    await writeFile(context.fsPath, 'export const mixedQuestionFixture = true;\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(context));
    await writeFile(path.join(root, 'native-ux-questions-ready.json'), '{}', { mode: 0o600 });
    await fileSignal(path.join(root, 'native-ux-questions-go'));
    const reply = await prompt(
      'Do not create todos, edit files, read files or run commands. Call ask exactly once with this JSON: ' +
        JSON.stringify({ questions: mixedQuestions }) +
        '. After the user answers, report every actual selected label and both free-text answers verbatim, then stop. Do not retry ask.',
      () => false,
    );
    const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
    assert.equal(report.tools.length, 1);
    assert.equal(report.tools[0].name, 'ask');
    const results = report.results.filter((item: { name: string }) => item.name === 'ask');
    assert.equal(results.length, 1);
    assert.deepEqual(JSON.parse(JSON.parse(results[0].content)[0].text), {
      status: 'answered',
      answers: {
        Output: { selected: ['JSON', 'Text'], freeText: 'Include a short summary' },
        Scope: { selected: ['Large'] },
        Notes: { selected: [], freeText: 'Preserve exact values' },
      },
    });
    assert.equal(
      ['JSON', 'Text', 'Large', 'Include a short summary', 'Preserve exact values'].every((value) =>
        reply.includes(value),
      ),
      true,
      'Provider answer content withheld.',
    );
    assert.equal(api.status()!.question, undefined);
    assert.deepEqual(api.storedState!().changes, changes);
    await writeFile(path.join(root, 'native-ux-questions-done'), 'done', { mode: 0o600 });
    await fileSignal(path.join(root, 'native-ux-questions-visible'));
    console.log(
      'PASS: genuine mixed in-chat questions submit exact selections and text once and continue without changing review.',
    );
  } finally {
    await config.update('notifications.focus', previous, vscode.ConfigurationTarget.Workspace);
  }
}

async function stopSignal(
  file: string,
  operation: () => Promise<void>,
  cancel: () => Promise<unknown>,
): Promise<void> {
  let observed!: () => void;
  const ready = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const watcher = watch(path.dirname(file), (_event, name) => {
    if (name === path.basename(file)) observed();
  });
  const timer = setTimeout(observed, 90000);
  try {
    const running = operation();
    await ready;
    await readFile(file);
    await cancel();
    await running;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

export async function questionWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  const ask = (text: string) =>
    prompt('Do not create todos, edit files or run commands. ' + text, () => false);
  const first = await ask(
    'Use editor search with literal query Math.ceil and glob src/**/*.ts. Then use ask with exactly header "Parity Choice", question "Choose a format", options JSON and Text, and allowFreeformInput false. Report the actual answer.',
  );
  assert.match(first, /JSON/);
  const second = await ask(
    'Use editor search with literal query UNSAVED_UNRELATED_USER_WORK and glob scratch.md to inspect unsaved editor text. Then use ask with exactly header "Parity Many", question "Select checks", multiSelect true, allowFreeformInput false and options Diagnostics, References, Tests. Report all actual selections.',
  );
  assert.match(second, /Diagnostics/);
  assert.match(second, /Tests/);
  const text = await ask(
    'Use ask with exactly header "Parity Text", question "Supply the fixture answer", options null and allowFreeformInput true. Do not invent placeholder choices. Report the actual free-text answer exactly.',
  );
  assert.match(text, /Exact native user answer/);
  await ask(
    'Use ask with exactly header "Parity Dismiss", question "Choose a format", options JSON and Text, and allowFreeformInput false. If dismissed, report cancellation only; do not retry or invent an answer.',
  );
  await stopSignal(
    path.join(root, 'native-question-stop'),
    async () => {
      await api.request!({
        v: 1,
        type: 'prompt',
        text: 'Do not create todos, edit files or run commands. Use ask with exactly header "Parity Stop", question "Stop this question", options only "Never choose this", and allowFreeformInput false. Wait for the user.',
      });
    },
    () => api.request!({ v: 1, type: 'cancel' }),
  );
  assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
  await ask(
    'The question was stopped. Use editor search with literal query Math.ceil and glob src/**/*.ts again. Report the unchanged rate and that no answer was received for the stopped question.',
  );
  const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  const calls = report.tools.filter((tool: { name: string }) => tool.name === 'ask');
  assert.equal(calls.length, 5);
  const searches = report.tools.filter(
    (tool: { name: string; input: string }) =>
      tool.name === 'editor' && JSON.parse(tool.input).action === 'search',
  );
  assert.ok(searches.length >= 3);
  assert.ok(
    report.results.some(
      (result: { name: string; content: string; isError: boolean }) =>
        result.name === 'editor' &&
        !result.isError &&
        result.content.includes('UNSAVED_UNRELATED_USER_WORK'),
    ),
  );
  const answers = report.results
    .filter(
      (result: { name: string; isError: boolean }) => result.name === 'ask' && !result.isError,
    )
    .map((result: { content: string }) => JSON.parse(JSON.parse(result.content)[0].text));
  assert.equal(
    answers.filter((answer: { status: string }) => answer.status === 'answered').length,
    3,
  );
  assert.equal(
    answers.filter((answer: { status: string }) => answer.status === 'cancelled').length,
    1,
  );
  assert.equal(api.status()!.changes.length, 0);
  console.log(
    'PASS: six-turn real-model literal/unsaved search, native single/multiple/free-text questions, dismissal, Stop and fresh-state recovery.',
  );
}
