import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activate as activateHost, deactivate as deactivateHost } from '../extension.js';
import { observeCrashes } from './crash-observer.js';

type Api = Awaited<ReturnType<typeof activateHost>>;
type Observation = ReturnType<typeof observeCrashes>;

async function prepare(api: Api, observation: Observation, directory: string) {
  const request = (message: object) => api.request!({ v: 1, ...message });
  await request({ type: 'connect' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ type: 'prompt', text: 'CRASH_PAST WRITE_FIXTURE' });
  await request({ type: 'prompt', text: 'CRASH_FUTURE' });
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const dirtyFile = vscode.Uri.joinPath(root, 'dirty.txt');
  await writeFile(dirtyFile.fsPath, 'disk baseline\n');
  const document = await vscode.workspace.openTextDocument(dirtyFile);
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(dirtyFile, document.positionAt(0), 'unsaved ');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const saved = api.storedState!();
  await writeFile(
    path.join(directory, 'expected.json'),
    JSON.stringify({
      sourceId: api.status()!.sessionId,
      changes: saved.changes,
      turns: api.status()!.turns,
      dirtyUri: dirtyFile.toString(),
      dirtyText: document.getText(),
      file: await readFile(vscode.Uri.joinPath(root, 'history.txt').fsPath, 'utf8'),
    }),
    { mode: 0o600 },
  );
  observation.sourceId = api.status()!.sessionId!;
  observation.armed = true;
  const stage = process.env.VS_OMP_CRASH_STAGE!;
  const selected = api.status()!.turns[1]!;
  if (stage.startsWith('fork-'))
    await request({ type: 'forkTurn', id: selected.id, boundary: 'before' });
  else await request({ type: 'editPrompt', id: selected.id, text: 'CRASH_REPLACEMENT' });
  throw new Error(`Crash checkpoint was not reached: ${stage}`);
}

async function recover(api: Api, observation: Observation, directory: string) {
  const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
  const ready = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8'));
  const request = (message: object) => api.request!({ v: 1, ...message });
  const loaded = api.storedState!();
  assert.ok(loaded.sessions.some((session) => session.id === expected.sourceId));
  await request({ type: 'connect' });
  assert.equal(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'), ready.provider);
  assert.deepEqual(api.storedState!().changes, expected.changes);
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  assert.equal(
    await readFile(vscode.Uri.joinPath(root, 'history.txt').fsPath, 'utf8'),
    expected.file,
  );
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(expected.dirtyUri));
  assert.equal(document.getText(), expected.dirtyText);
  assert.equal(document.isDirty, true);
  const source = api.storedState!().sessions.find((session) => session.id === expected.sourceId)!;
  const stage = process.env.VS_OMP_CRASH_STAGE!;
  const prefixOnly = ['navigated', 'verified', 'rewound'].includes(stage);
  assert.equal(source.turns.length, prefixOnly ? 1 : 2);
  assert.ok(source.turns.every((turn) => turn.status !== 'running'));
  if (['replacement', 'submitted'].includes(stage))
    assert.equal(source.turns.at(-1)!.status, 'cancelled');
  if (stage === 'final') assert.equal(source.turns.at(-1)!.status, 'completed');
  const snapshot = await observation.client!.history();
  assert.ok(snapshot.entries.some((entry) => entry.id === expected.turns[0].history.promptEntryId));
  const excluded = [
    ...['navigated', 'verified', 'rewound', 'replacement', 'submitted', 'final'],
    ...['fork-save', 'fork-selected'],
  ].includes(stage);
  assert.equal(
    snapshot.entries.some((entry) => entry.id === expected.turns[1].history.promptEntryId),
    !excluded,
  );
  const archive = api.storedState!().sessions.find((session) =>
    session.label.endsWith('(before edit)'),
  );
  if (!['archive', 'intent-before', 'fork-save', 'fork-selected'].includes(stage))
    assert.ok(archive, 'A durable edit intent must retain its complete archive');
  if (archive) {
    await api.resume!(archive.id);
    const archived = await observation.client!.history();
    assert.ok(
      archived.entries.some((entry) => entry.id === expected.turns[1].history.promptEntryId),
    );
    assert.deepEqual(api.storedState!().changes, expected.changes);
  }
  if (stage.startsWith('fork-')) {
    assert.notEqual(api.status()!.sessionId, expected.sourceId);
    await api.resume!(expected.sourceId);
    assert.ok(
      (await observation.client!.history()).entries.some(
        (entry) => entry.id === expected.turns[1].history.promptEntryId,
      ),
    );
  }
  assert.equal(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'), ready.provider);
  await deactivateHost();
}

async function run(context: vscode.ExtensionContext) {
  const directory = process.env.VS_OMP_CRASH_DIRECTORY!;
  const observation = observeCrashes(directory, process.env.VS_OMP_CRASH_STAGE!);
  const storage = vscode.Uri.file(path.join(directory, 'storage'));
  const api = await activateHost({
    subscriptions: context.subscriptions,
    extensionMode: vscode.ExtensionMode.Test,
    extensionUri: vscode.Uri.file(process.env.VS_OMP_NATIVE_EXTENSION_ROOT!),
    storageUri: storage,
    globalStorageUri: storage,
  } as vscode.ExtensionContext);
  const phase = await readFile(path.join(directory, 'phase'), 'utf8');
  if (phase === 'prepare') await prepare(api, observation, directory);
  else await recover(api, observation, directory);
}

export function activate(context: vscode.ExtensionContext) {
  void run(context).then(
    () =>
      writeFile(
        path.join(process.env.VS_OMP_CRASH_DIRECTORY!, 'result.json'),
        JSON.stringify({ ok: true }),
      ),
    (error: unknown) =>
      writeFile(
        path.join(process.env.VS_OMP_CRASH_DIRECTORY!, 'result.json'),
        JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }),
      ),
  );
}
