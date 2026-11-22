import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codeActionFixtures, refactorFixtures } from './code-actions.integration.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Prompt = (text: string, approve: () => boolean) => Promise<string>;

async function actionEvidence(): Promise<void> {
  const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  assert.ok(
    report.tools.every((entry: { name: string }) => ['read', 'code_action'].includes(entry.name)),
  );
  const calls = report.tools
    .filter((entry: { name: string }) => entry.name === 'code_action')
    .map((entry: { input: string }) => JSON.parse(entry.input));
  assert.deepEqual(
    calls.map((input: { action: string }) => input.action),
    ['list', 'apply', 'list', 'apply', 'list'],
  );
  const results = report.results
    .filter((entry: { name: string }) => entry.name === 'code_action')
    .map((entry: { content: string }) => JSON.parse(JSON.parse(entry.content)[0].text));
  assert.equal(results[1].completed, 1);
  assert.equal(results[3].completed, 1);
  assert.ok(
    results[0].actions.some(
      (entry: { available: boolean; commandIgnored: boolean }) =>
        entry.available && entry.commandIgnored,
    ),
  );
  assert.ok(results[4].actions.every((entry: { available: boolean }) => !entry.available));
  assert.ok(report.results.every((entry: { isError: boolean }) => !entry.isError));
}

export async function codeActionWorkflow(api: Api, root: string, prompt: Prompt): Promise<void> {
  const fixture = await codeActionFixtures(vscode.Uri.file(root));
  const ask = (text: string) =>
    prompt(
      'Use only read and code_action. No manual edits, writes, shell, editor commands or other tools. ' +
        text,
      () => false,
    );
  await ask(
    'Read action-source.ts and action-dependency.ts. List source.organizeImports code actions for action-source.ts at the empty 1-based range 1:1-1:1, title:null and paths containing only that file. Report the exact available title and whether the attached command is ignored. Do not apply yet.',
  );
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), fixture.before);
  assert.equal(api.status()!.changes.length, 0);
  await ask(
    'Apply the exact available title from the previous list to the same file/range/kind/paths using code_action exactly once. Apply only its resolved text edit, never its attached command. Report the result and leave the change in review. Do not list or retry.',
  );
  const after = await readFile(fixture.source.fsPath, 'utf8');
  assert.doesNotMatch(after, /unused/);
  assert.match(after, /export const result = used/);
  assert.equal(api.status()!.changes.length, 1);
  assert.equal(api.status()!.changes[0]!.operations![0]!.tool, 'code_action');
  await api.request!({ v: 1, type: 'discard', id: api.status()!.changes[0]!.id });
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), fixture.before);
  await ask(
    'I discarded the import edit. Reread action-source.ts now, then list source.organizeImports at the same empty 1:1-1:1 range with title:null and only that captured path. Report the restored unused import and fresh availability, not earlier edited content. Do not apply.',
  );
  await ask(
    'Apply the exact available title from that fresh list once to the same file/range/kind/paths. Use only its resolved text edit and leave it in review. Do not list again, manually edit or retry.',
  );
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), after);
  assert.equal(api.status()!.changes.length, 1);
  await api.request!({ v: 1, type: 'keep', id: api.status()!.changes[0]!.id });
  await ask(
    'I kept the import edit. Read action-source.ts fresh and list source.organizeImports again for the same empty range and only that path, title:null. Report current imports and whether any resolved text change remains available. Do not apply or repair anything.',
  );
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), after);
  assert.equal(api.status()!.changes.length, 0);
  await actionEvidence();
  console.log(
    'PASS: five-turn genuine-model provider action discovery, text-only import organization, durable review, Discard/fresh discovery, second application, Keep and no-change availability.',
  );
}

export function isRefactorInvocation(context: {
  triggerKind: vscode.CodeActionTriggerKind;
  only?: { readonly value: string };
}): boolean {
  return (
    context.triggerKind === vscode.CodeActionTriggerKind.Invoke &&
    context.only?.value === 'refactor.rewrite.export.default'
  );
}

async function stopRefactor(api: Api) {
  let entered!: () => void;
  let release!: (value: vscode.CodeAction[]) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<vscode.CodeAction[]>((resolve) => {
    release = resolve;
  });
  const provider = vscode.languages.registerCodeActionsProvider(
    { language: 'typescript', scheme: 'file' },
    {
      provideCodeActions: (_document, _range, context) => {
        if (!isRefactorInvocation(context)) return [];
        entered();
        return pending;
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.Refactor.append('rewrite.export.default')] },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Model refactor discovery did not reach the owned hold')),
      45000,
    );
  });
  const running = api.request!({
    v: 1,
    type: 'prompt',
    text: 'Use only code_action. List refactor.rewrite.export.default for source.ts with action:"list", line:1, column:17, endLine:1, endColumn:29, title:null, paths:["source.ts","usage.ts"]. Do not apply, use other tools or retry. I will stop this pending discovery.',
  });
  try {
    await Promise.race([
      started,
      expired,
      running.then(() => {
        throw new Error('Refactor prompt ended before Stop');
      }),
    ]);
    const held = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
    const calls = held.tools.filter((entry: { name: string }) => entry.name === 'code_action');
    assert.equal(calls.length, 5);
    const input = JSON.parse(calls.at(-1).input);
    assert.equal(input.action, 'list');
    assert.equal(input.kind, 'refactor.rewrite.export.default');
    await api.request!({ v: 1, type: 'cancel' });
    await running;
    release([]);
    assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
    const after = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
    assert.equal(after.requests.length, held.requests.length);
    assert.equal(api.status()!.changes.length, 0);
  } finally {
    clearTimeout(timer);
    release([]);
    provider.dispose();
    if (api.status()!.busy) await api.request!({ v: 1, type: 'cancel' });
    await running;
  }
}

export function isStoppedRefactorResult(entry: { name: string; content: string }): boolean {
  if (entry.name !== 'code_action') return false;
  const content = JSON.parse(entry.content);
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    content[0]?.text === 'Interrupted by user'
  );
}

async function retrievalEvidence() {
  const report = JSON.parse(await readFile(process.env.VS_OMP_LIVE_REPORT!, 'utf8'));
  assert.ok(
    report.tools.every((entry: { name: string }) =>
      ['read', 'editor', 'code_action'].includes(entry.name),
    ),
  );
  const calls = report.tools
    .filter((entry: { name: string }) => entry.name === 'code_action')
    .map((entry: { input: string }) => JSON.parse(entry.input));
  assert.deepEqual(
    calls.map((input: { action: string }) => input.action),
    ['list', 'apply', 'list', 'apply', 'list'],
  );
  assert.ok(
    calls.every((input: { kind: string }) => input.kind === 'refactor.rewrite.export.default'),
  );
  const results = report.results.filter((entry: { name: string }) => entry.name === 'code_action');
  for (const index of [1, 3]) {
    const result = JSON.parse(JSON.parse(results[index].content)[0].text);
    assert.equal(result.completed, 2);
  }
  const editor = report.tools
    .filter((entry: { name: string }) => entry.name === 'editor')
    .map((entry: { input: string }) => JSON.parse(entry.input));
  assert.deepEqual(
    editor.map((input: { action: string }) => input.action),
    ['semanticSearch', 'search'],
  );
  assert.equal(editor[0].backend, 'local-lsa-v1');
  const inspections = report.results
    .filter((entry: { name: string }) => entry.name === 'editor')
    .map((entry: { content: string }) => JSON.parse(JSON.parse(entry.content)[0].text));
  assert.ok(inspections[0].items.some((item: { path: string }) => item.path === 'source.ts'));
  assert.equal(inspections[0].stale, false);
  assert.equal(inspections[0].inferenceRequests, 0);
  assert.equal(inspections[1].items.length, 0);
  const errors = report.results.filter((entry: { isError: boolean }) => entry.isError);
  assert.equal(errors.length, 1);
  assert.ok(errors.every(isStoppedRefactorResult));
}

export async function retrievalRefactorWorkflow(api: Api, root: string, prompt: Prompt) {
  const fixture = await refactorFixtures(vscode.Uri.file(root));
  const ask = (text: string) =>
    prompt(
      'Use only editor, read and code_action. No writes, shell, manual edits, provider commands, retries or other tools. ' +
        text,
      () => false,
    );
  await ask(
    'Find the price calculation using editor semanticSearch with backend:"local-lsa-v1", query:"price amount calculation", glob:"**/*.ts", limit:5. Then use editor action:search once for exactly that query. Read the discovered calculation file and its caller. Next invoke the separate code_action tool, NOT editor, with action:"list", kind:"refactor.rewrite.export.default", line:1, column:17, endLine:1, endColumn:29, title:null, and paths containing both discovered files. The line is ONE and the column is SEVENTEEN. Report exact availability and the literal/semantic distinction; do not apply. editor has no list-code-actions action.',
  );
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), fixture.before);
  assert.equal(api.status()!.changes.length, 0);
  await ask(
    'Apply the exact freshly listed export-conversion title once with code_action, action:"apply", line:1, column:17, endLine:1, endColumn:29, kind:"refactor.rewrite.export.default" and the same two captured paths. Leave both file edits in review. Ignore attached commands; do not list again.',
  );
  const after = await refactorAfter(api, fixture);
  for (const change of [...api.status()!.changes])
    await api.request!({ v: 1, type: 'discard', id: change.id });
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), fixture.before);
  assert.equal(await readFile(fixture.usage.fsPath, 'utf8'), fixture.references);
  await ask(
    'I discarded both changes. Read both files fresh, report the restored named export/import, use code_action to list kind:"refactor.rewrite.export.default" with line:1, column:17, endLine:1, endColumn:29, title:null and both paths, then apply its exact fresh title once with those same explicit fields. Leave both edits in review.',
  );
  assert.deepEqual(await refactorAfter(api, fixture), after);
  for (const change of [...api.status()!.changes])
    await api.request!({ v: 1, type: 'keep', id: change.id });
  await ask(
    'I kept both edits. Read both files fresh and report the current default export/import, unchanged call and shadowed parameter. Do not list, apply, repair or use cached text.',
  );
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), after.source);
  assert.equal(await readFile(fixture.usage.fsPath, 'utf8'), after.usage);
  await stopRefactor(api);
  assert.equal(await readFile(fixture.source.fsPath, 'utf8'), after.source);
  assert.equal(await readFile(fixture.usage.fsPath, 'utf8'), after.usage);
  await retrievalEvidence();
  console.log(
    'PASS: genuine semantic discovery versus literal control, real cross-file TypeScript refactor, Discard/fresh reapply/Keep/reread and Stop during an owned provider hold.',
  );
}

async function refactorAfter(api: Api, fixture: Awaited<ReturnType<typeof refactorFixtures>>) {
  const source = await readFile(fixture.source.fsPath, 'utf8');
  const usage = await readFile(fixture.usage.fsPath, 'utf8');
  assert.ok(source.includes('export default function pricedAmount'));
  assert.ok(source.includes('export const unchanged = 11;'));
  assert.ok(usage.includes('import pricedAmount from "./source";'));
  assert.ok(usage.includes(fixture.references.split('\n')[2]!));
  assert.equal(api.status()!.changes.length, 2);
  assert.ok(api.status()!.changes.every((change) => change.operations![0]!.tool === 'code_action'));
  return { source, usage };
}
