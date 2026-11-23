import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileSignal } from './production-terminal.integration.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;

async function unchangedProvider(expected: string) {
  assert.ok(
    (await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')) === expected,
    'Native UX action changed provider context; content withheld.',
  );
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function historyDigest(turns: unknown): string {
  const keys = new Set<string>();
  JSON.stringify(turns, (key, value) => {
    keys.add(key);
    return value;
  });
  return digest(JSON.stringify(turns, [...keys].sort()));
}

export async function prepareUXReopen(api: Api, root: vscode.Uri) {
  await api.request!({ v: 1, type: 'disconnect' });
  const session = api.storedState!().sessions.find(
    (entry) => entry.title === 'Native UX named session',
  )!;
  assert.ok(session);
  await api.request!({ v: 1, type: 'archiveSession', id: session.id });
  const saved = api.storedState!().sessions.find((entry) => entry.id === session.id)!;
  assert.ok(saved.archivedAt !== undefined);
  await writeFile(
    vscode.Uri.joinPath(root, 'native-ux-reopen.json').fsPath,
    JSON.stringify({
      id: saved.id,
      title: saved.title,
      archivedAt: saved.archivedAt,
      turnsHash: historyDigest(saved.turns),
      changeIds: api.storedState!().changes.map((entry) => entry.id),
      providerHash: digest(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')),
    }),
    { mode: 0o600 },
  );
}

export async function verifyUXReopen(api: Api, root: vscode.Uri) {
  const expected = JSON.parse(
    await readFile(vscode.Uri.joinPath(root, 'native-ux-reopen.json').fsPath, 'utf8'),
  );
  const before = api.storedState!();
  const saved = before.sessions.find((entry) => entry.id === expected.id)!;
  assert.equal(saved.title, expected.title);
  assert.equal(saved.archivedAt, expected.archivedAt);
  assert.equal(historyDigest(saved.turns), expected.turnsHash);
  assert.deepEqual(
    before.changes.map((entry) => entry.id),
    expected.changeIds,
  );
  assert.equal(api.status()!.connected, false);
  assert.equal(api.status()!.question, undefined);
  await api.request!({ v: 1, type: 'openSession', id: saved.id });
  assert.equal(api.status()!.connected, false);
  await api.request!({ v: 1, type: 'restoreSession', id: saved.id });
  const restored = api.storedState!().sessions.find((entry) => entry.id === saved.id)!;
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.title, expected.title);
  assert.equal(historyDigest(restored.turns), expected.turnsHash);
  assert.deepEqual(
    api.storedState!().changes.map((entry) => entry.id),
    expected.changeIds,
  );
  assert.equal(
    digest(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')),
    expected.providerHash,
  );
  console.log(
    'PASS: actual process reopen preserves user archive, title, exact history and review identity; read-only Open and explicit Restore cause no generation or revived question.',
  );
}

async function nativeContextMenu(api: Api, root: vscode.Uri) {
  const target = vscode.Uri.joinPath(root, 'context-entry.ts');
  await writeFile(target.fsPath, 'export const format = "json";\n');
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(target, document.positionAt(0), '// Unsaved explicit native context\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const provider = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  const changes = structuredClone(api.storedState!().changes);
  const signal = vscode.Uri.joinPath(root, 'native-ux-context-ready.json').fsPath;
  await writeFile(signal, JSON.stringify({ file: 'context-entry.ts' }), { mode: 0o600 });
  await fileSignal(vscode.Uri.joinPath(root, 'native-ux-context-done').fsPath);
  const attachment = api.status()!.attachments.find((item) => item.uri === target.toString());
  assert.ok(attachment, 'The contributed editor-tab menu must attach the clicked resource.');
  assert.equal(document.isDirty, true);
  assert.equal(await readFile(target.fsPath, 'utf8'), 'export const format = "json";\n');
  assert.deepEqual(api.storedState!().changes, changes);
  await unchangedProvider(provider);
  const later = new vscode.WorkspaceEdit();
  later.insert(target, document.positionAt(0), '// LATER_BUFFER_MUST_NOT_ATTACH\n');
  assert.ok(await vscode.workspace.applyEdit(later));
  await api.request!({ v: 1, type: 'prompt', text: 'NATIVE_CONTEXT_CAPTURE_VALIDATION' });
  const captured = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  assert.match(captured, /Unsaved explicit native context/);
  assert.match(captured, /export const format/);
  assert.doesNotMatch(captured, /LATER_BUFFER_MUST_NOT_ATTACH/);
  assert.equal(document.isDirty, true);
  assert.deepEqual(api.storedState!().changes, changes);
  await writeFile(vscode.Uri.joinPath(root, 'native-ux-tables-ready').fsPath, 'ready', {
    mode: 0o600,
  });
  await fileSignal(vscode.Uri.joinPath(root, 'native-ux-tables-checked').fsPath);
  console.log(
    'PASS: actual contributed editor-tab context menu captures the clicked unsaved resource without generation, disk mutation or review changes.',
  );
}

async function questionPrompt(api: Api, text = 'NATIVE_UX_QUESTION_FIXTURE') {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void api.request!({ v: 1, type: 'cancel' }).catch((error: unknown) => {
      console.error('Native UX fixture Stop failed.', error);
    });
  }, 20000);
  try {
    await api.request!({ v: 1, type: 'prompt', text });
    assert.equal(expired, false, 'Native UX question fixture exceeded its explicit test deadline.');
  } finally {
    clearTimeout(timer);
  }
}

async function uxAppearance(theme: string, zoom: number) {
  const settings = [
    { section: 'workbench', key: 'colorTheme', value: theme },
    { section: 'window', key: 'zoomLevel', value: zoom },
  ].map((setting) => {
    const config = vscode.workspace.getConfiguration(setting.section);
    return { ...setting, config, previous: config.inspect(setting.key)?.globalValue };
  });
  const restore = async () => {
    for (const setting of settings)
      await setting.config.update(setting.key, setting.previous, vscode.ConfigurationTarget.Global);
  };
  try {
    for (const setting of settings)
      await setting.config.update(setting.key, setting.value, vscode.ConfigurationTarget.Global);
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}

async function nativeQuestions(api: Api, root: vscode.Uri) {
  const config = vscode.workspace.getConfiguration('omp');
  const previous = config.inspect<string>('notifications.focus')?.workspaceValue;
  const changes = structuredClone(api.storedState!().changes);
  await config.update('notifications.focus', 'always', vscode.ConfigurationTarget.Workspace);
  const restore = await uxAppearance('Default Light Modern', 0);
  try {
    await writeFile(vscode.Uri.joinPath(root, 'native-ux-questions-ready.json').fsPath, '{}', {
      mode: 0o600,
    });
    await fileSignal(vscode.Uri.joinPath(root, 'native-ux-questions-go').fsPath);
    await questionPrompt(api);
    const provider = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
    const result = provider.messages.findLast(
      (message: { role: string }) => message.role === 'toolResult',
    );
    const answer = JSON.parse(
      result.content.find((part: { type: string }) => part.type === 'text').text,
    );
    assert.deepEqual(answer, {
      status: 'answered',
      answers: {
        Output: { selected: ['JSON', 'Text'], freeText: 'Include a short summary' },
        Scope: { selected: ['Large'] },
        Notes: { selected: [], freeText: 'Preserve exact values' },
      },
    });
    assert.equal(api.status()!.question, undefined);
    assert.deepEqual(api.storedState!().changes, changes);
    await writeFile(vscode.Uri.joinPath(root, 'native-ux-questions-done').fsPath, 'done', {
      mode: 0o600,
    });
    await fileSignal(vscode.Uri.joinPath(root, 'native-ux-questions-visible').fsPath);
    console.log(
      'PASS: installed OMP mixed questions use owned in-chat controls, native attention action, explicit review/submit and exact answers without changing review.',
    );
  } finally {
    await restore();
    await config.update('notifications.focus', previous, vscode.ConfigurationTarget.Workspace);
  }
}

async function nativeQuestionRetirement(api: Api, root: vscode.Uri) {
  const changes = api.storedState!().changes;
  const config = vscode.workspace.getConfiguration('omp');
  const cases = [
    { scenario: 'cancel', key: 'notifications.questions', value: false },
    { scenario: 'stop', key: 'notifications.questions', value: false },
    { scenario: 'reload', key: 'notifications.enabled', value: false },
    { scenario: 'dismiss', key: 'notifications.focus', value: 'always' },
    { scenario: 'stale', key: 'notifications.focus', value: 'always' },
  ];
  for (const { scenario, key, value } of cases) {
    const previous = config.inspect(key)?.workspaceValue;
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    const name = `native-ux-question-${scenario}`;
    await writeFile(vscode.Uri.joinPath(root, `${name}-ready`).fsPath, 'ready', { mode: 0o600 });
    const running = questionPrompt(api, `NATIVE_UX_QUESTION_FIXTURE ${scenario}`);
    void running.catch(() => {});
    try {
      await fileSignal(vscode.Uri.joinPath(root, `${name}-held`).fsPath);
      const id = api.status()!.question!.id;
      const held = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
      await writeFile(vscode.Uri.joinPath(root, `${name}-held-checked`).fsPath, 'checked', {
        mode: 0o600,
      });
      if (scenario === 'dismiss') {
        await fileSignal(vscode.Uri.joinPath(root, `${name}-dismissed`).fsPath);
        assert.equal(api.status()!.question!.id, id);
        await unchangedProvider(held);
        await writeFile(vscode.Uri.joinPath(root, `${name}-dismissed-checked`).fsPath, 'checked', {
          mode: 0o600,
        });
      }
      await running;
      assert.equal(api.status()!.question, undefined);
      if (scenario === 'stop') {
        assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
        await unchangedProvider(held);
      } else {
        const provider = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
        const result = provider.messages.findLast(
          (message: { role: string }) => message.role === 'toolResult',
        );
        assert.deepEqual(
          JSON.parse(result.content.find((part: { type: string }) => part.type === 'text').text),
          { status: 'cancelled', answers: {} },
        );
      }
      assert.ok(
        !(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8')).includes(
          'NATIVE_UNSUBMITTED_ANSWER',
        ),
      );
      const completed = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
      const turns = api.status()!.turns;
      await api.request!({ v: 1, type: 'questionAnswer', id, answers: [{ selected: ['JSON'] }] });
      assert.equal(api.status()!.question, undefined);
      assert.deepEqual(api.status()!.turns, turns);
      await unchangedProvider(completed);
      assert.deepEqual(api.storedState!().changes, changes);
      await writeFile(vscode.Uri.joinPath(root, `${name}-done`).fsPath, 'done', { mode: 0o600 });
      if (scenario === 'stale') {
        await fileSignal(vscode.Uri.joinPath(root, `${name}-center-ready`).fsPath);
        assert.ok((await vscode.commands.getCommands(true)).includes('notifications.showList'));
        await vscode.commands.executeCommand('notifications.showList');
      }
      await fileSignal(vscode.Uri.joinPath(root, `${name}-visible`).fsPath);
      await unchangedProvider(completed);
      console.log(
        `PASS: native question ${scenario} retires exact request, rejects late answers and preserves review without submitting draft input.`,
      );
    } finally {
      await api.request!({ v: 1, type: 'cancel' });
      await Promise.allSettled([running]);
      await config.update(key, previous, vscode.ConfigurationTarget.Workspace);
    }
  }
}

async function nativeAttention(api: Api, root: vscode.Uri) {
  const config = vscode.workspace.getConfiguration('omp');
  const mode = config.inspect('permissions.defaultMode')?.globalValue;
  const focus = config.inspect('notifications.focus')?.workspaceValue;
  await config.update('permissions.defaultMode', 'ask', vscode.ConfigurationTarget.Global);
  await config.update('notifications.focus', 'always', vscode.ConfigurationTarget.Workspace);
  const command = 'notifications.toggleDoNotDisturbMode';
  assert.ok((await vscode.commands.getCommands(true)).includes(command));
  let doNotDisturb = true;
  await vscode.commands.executeCommand(command);
  const restore = await uxAppearance('Default High Contrast', 1);
  try {
    await api.request!({ v: 1, type: 'disconnect' });
    await api.request!({ v: 1, type: 'connect' });
    await api.request!({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
    const prefix = vscode.Uri.joinPath(root, 'native-ux-attention').fsPath;
    await writeFile(`${prefix}-ready`, 'ready', { mode: 0o600 });
    await fileSignal(`${prefix}-go`);
    const running = questionPrompt(api, 'REPOSITORY_READOUT_FIXTURE shell');
    void running.catch(() => {});
    try {
      await fileSignal(`${prefix}-held`);
      const approval = api.status()!.approval!;
      assert.ok(approval);
      const provider = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
      await writeFile(`${prefix}-held-checked`, 'checked', { mode: 0o600 });
      await fileSignal(`${prefix}-focused`);
      assert.equal(api.status()!.approval!.id, approval.id);
      await unchangedProvider(provider);
      await vscode.commands.executeCommand(command);
      doNotDisturb = false;
      await writeFile(`${prefix}-focused-checked`, 'checked', { mode: 0o600 });
      await running;
      assert.equal(api.status()!.approval, undefined);
      assert.equal(api.status()!.turns.at(-1)!.status, 'completed');
      const completed = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
      await writeFile(`${prefix}-done`, 'done', { mode: 0o600 });
      await fileSignal(`${prefix}-finished-checked`);
      await unchangedProvider(completed);
      await vscode.commands.executeCommand('notifications.hideList');
      await vscode.commands.executeCommand('notifications.hideToasts');
    } finally {
      await api.request!({ v: 1, type: 'cancel' });
      await Promise.allSettled([running]);
    }
  } finally {
    await restore();
    if (doNotDisturb) await vscode.commands.executeCommand(command);
    await config.update('permissions.defaultMode', mode, vscode.ConfigurationTarget.Global);
    await config.update('notifications.focus', focus, vscode.ConfigurationTarget.Workspace);
  }
}

const managerStages = [
  { name: 'renamed', archived: false, active: true, connected: true },
  { name: 'archived', archived: true, active: false, connected: false },
  { name: 'recreated', archived: true, active: false, connected: false },
  { name: 'opened', archived: true, active: true, connected: false },
  { name: 'restored', archived: false, active: true, connected: false },
  { name: 'resumed', archived: false, active: true, connected: true },
];

async function nativeManager(api: Api, root: vscode.Uri) {
  const before = api.storedState!();
  const original = before.sessions.find((session) => session.id === before.activeSessionId)!;
  assert.ok(original);
  const provider = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  await writeFile(
    vscode.Uri.joinPath(root, 'native-ux-manager-ready.json').fsPath,
    JSON.stringify({ id: original.id }),
    { mode: 0o600 },
  );
  for (const stage of managerStages) {
    const name = `native-ux-manager-${stage.name}`;
    await fileSignal(vscode.Uri.joinPath(root, name).fsPath);
    const current = api.storedState!();
    const saved = current.sessions.find((session) => session.id === original.id)!;
    assert.equal(saved.title, 'Native UX named session');
    assert.equal(saved.archivedAt !== undefined, stage.archived);
    assert.equal(current.activeSessionId, stage.active ? original.id : undefined);
    assert.equal(api.status()!.connected, stage.connected);
    assert.deepEqual(saved.turns, original.turns);
    assert.deepEqual(current.changes, before.changes);
    await unchangedProvider(provider);
    assert.equal(
      vscode.workspace.textDocuments.find(
        (document) =>
          document.uri.toString() === vscode.Uri.joinPath(root, 'context-entry.ts').toString(),
      )?.isDirty,
      true,
    );
    await writeFile(vscode.Uri.joinPath(root, `${name}-checked`).fsPath, 'checked', {
      mode: 0o600,
    });
  }
  console.log(
    'PASS: native manager search, rename, archive, read-only open, restore and explicit resume preserve exact turns, provider context, dirty buffer and pending review.',
  );
}

async function inlineCheckpoint(root: vscode.Uri, stage: string) {
  const name = `native-ux-inline-${stage}`;
  await fileSignal(vscode.Uri.joinPath(root, name).fsPath);
  return () =>
    writeFile(vscode.Uri.joinPath(root, `${name}-checked`).fsPath, 'checked', { mode: 0o600 });
}

const inlineReviewBefore = [
  "export function formatHeader(value = '') {",
  '  return `Header: ${value}`;',
  '}',
  '',
  'export const sampleRows = [',
  ...'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    .split(' ')
    .map((word) => `  '${word}',`),
  '];',
  '',
  "export function formatFooter(value = '') {",
  '  return `Footer: ${value}`;',
  '}',
  '',
].join('\n');

async function nativeInlineReview(api: Api, root: vscode.Uri) {
  const target = vscode.Uri.joinPath(root, 'review-sample.ts');
  const before = inlineReviewBefore;
  const earlier = api.storedState!().changes;
  await writeFile(target.fsPath, before);
  await api.request!({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  assert.equal(
    api.status()!.configs.find((config) => config.id === 'model')?.value,
    'vs-omp-fixture/history',
  );
  await api.request!({
    v: 1,
    type: 'prompt',
    text: 'Change Header: and Footer: to uppercase in review-sample.ts.',
  });
  const change = api.status()!.changes.find((entry) => entry.name === 'review-sample.ts')!;
  assert.equal(change.hunks.length, 2);
  const provider = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  const disk = await readFile(target.fsPath, 'utf8');
  const pending = api.storedState!().changes;
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await writeFile(
    vscode.Uri.joinPath(root, 'native-ux-inline-ready.json').fsPath,
    JSON.stringify({ id: change.id, hunks: change.hunks.map((hunk) => hunk.id) }),
    { mode: 0o600 },
  );
  const previewed = await inlineCheckpoint(root, 'previewed');
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputCustom);
  assert.equal(input.uri.scheme, 'omp-review');
  assert.equal(input.viewType, 'omp.inlineReview');
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.uri.toString() === input.uri.toString(),
    );
  assert.equal(tabs.length, 1, 'Repeated review must reuse its stable custom inline tab.');
  assert.deepEqual(api.storedState!().changes, pending);
  assert.equal(await readFile(target.fsPath, 'utf8'), disk);
  await unchangedProvider(provider);
  await previewed();
  const kept = await inlineCheckpoint(root, 'kept');
  const retained = api.storedState!().changes.find((entry) => entry.id === change.id)!;
  assert.equal(retained.before, before.replace('Header:', 'HEADER:'));
  assert.deepEqual(
    api
      .status()!
      .changes.find((entry) => entry.id === change.id)!
      .hunks.map((hunk) => hunk.id),
    [change.hunks[1]!.id],
  );
  assert.equal(await readFile(target.fsPath, 'utf8'), disk);
  await unchangedProvider(provider);
  await kept();
  const discarded = await inlineCheckpoint(root, 'discarded');
  assert.equal(await readFile(target.fsPath, 'utf8'), before.replace('Header:', 'HEADER:'));
  assert.deepEqual(api.storedState!().changes, earlier);
  await unchangedProvider(provider);
  await vscode.window.showTextDocument(target);
  await discarded();
  console.log(
    'PASS: public custom inline review and repeated snapshot reuse are read-only; floating Keep advances only its hunk baseline and Undo preserves the accepted hunk without generation.',
  );
}

export async function nativeUX(api: Api, root: vscode.Uri) {
  await nativeContextMenu(api, root);
  await nativeQuestions(api, root);
  await nativeQuestionRetirement(api, root);
  await nativeAttention(api, root);
  await nativeManager(api, root);
  await nativeInlineReview(api, root);
}
