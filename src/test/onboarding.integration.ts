import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ompVersionRequirement } from '../omp-version.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;

const startupCases = [
  ['missing', '', 'ENOENT'],
  ['incompatible', '--bad-version', `${ompVersionRequirement()} with ACP v1`],
  ['auth', '--unauthenticated', '/login github-copilot'],
] as const;

async function startupExecutable(directory: string, kind: string, flag: string): Promise<string> {
  const executable = path.join(directory, kind);
  if (!flag) return executable;
  const agent = path.join(
    path.dirname(path.dirname(process.env.VS_OMP_TEST_FIXTURE!)),
    'dist/test/acp-agent.js',
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    `#!/bin/sh\nif test "$1" = config; then printf '{"value":"mnemopi"}'; exit 0; fi\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(agent)} ${flag} "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function checkpoint(root: string, kind: string, hint: string): Promise<void> {
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checked = new Promise<void>((resolve, reject) => {
    watcher = watch(root, (_event, name) => {
      if (name === `native-onboarding-${kind}-checked`) resolve();
    });
    timer = setTimeout(
      () => reject(new Error('Native onboarding UI checkpoint exceeded budget.')),
      30000,
    );
  });
  try {
    await writeFile(path.join(root, `native-onboarding-${kind}.json`), JSON.stringify({ hint }), {
      mode: 0o600,
    });
    await checked;
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}

export async function nativeOnboarding(api: Api, root: vscode.Uri): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-onboarding-'));
  const config = vscode.workspace.getConfiguration('omp');
  const baseline = api.storedState!();
  const target = path.join(root.fsPath, 'onboarding-baseline.txt');
  await writeFile(target, 'UNCHANGED_ONBOARDING_BASELINE\n');
  try {
    for (const [kind, flag, hint] of startupCases) {
      const executable = await startupExecutable(directory, kind, flag);
      await config.update('executablePath', executable, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('omp.newSession');
      assert.equal(api.status()!.connected, false);
      assert.ok(api.status()!.error.includes(hint!));
      assert.deepEqual(api.storedState!(), baseline);
      assert.equal(await readFile(target, 'utf8'), 'UNCHANGED_ONBOARDING_BASELINE\n');
      await checkpoint(root.fsPath, kind!, hint!);
    }
    await config.update(
      'executablePath',
      process.env.OMP_EXECUTABLE,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand('omp.newSession');
    assert.equal(api.status()!.connected, true, api.status()!.error);
    assert.equal(api.status()!.error, '');
    assert.ok(api.status()!.configs.some((entry) => entry.id === 'model'));
    await api.request!({ v: 1, type: 'disconnect' });
    assert.equal(api.status()!.connected, false);
    console.log(
      'PASS: native fresh-profile missing runtime, incompatible ACP version, actionable auth refusal and explicit installed-OMP retry preserve state/files without generation.',
    );
  } finally {
    await config.update(
      'executablePath',
      process.env.OMP_EXECUTABLE,
      vscode.ConfigurationTarget.Global,
    );
    await rm(directory, { recursive: true, force: true });
  }
}

export async function nativeStorageInspection(api: Api): Promise<void> {
  const before = api.storedState!();
  await vscode.commands.executeCommand('omp.inspectStorage');
  const document = vscode.window.activeTextEditor!.document;
  assert.equal(document.uri.scheme, 'omp-storage');
  assert.notEqual(vscode.workspace.fs.isWritableFileSystem(document.uri.scheme), true);
  assert.equal(document.isDirty, false);
  const report = JSON.parse(document.getText());
  assert.equal(report.sessionCount, before.sessions.length);
  assert.equal(report.serializedStateBytes, Buffer.byteLength(JSON.stringify(before)));
  assert.equal(report.automaticDeletion, false);
  assert.equal(report.nativeArtifactSizes, 'regular-jsonl-only');
  await vscode.commands.executeCommand('omp.inspectStorage');
  assert.notEqual(vscode.window.activeTextEditor!.document.uri.toString(), document.uri.toString());
  assert.deepEqual(api.storedState!(), before);
  assert.notEqual(api.status()!.connected, true);
  console.log(
    'PASS: native storage inspection opens fresh read-only metadata without OMP or state changes.',
  );
}

async function publicStorage(): Promise<{ sessionCount: number; serializedStateBytes: number }> {
  await vscode.commands.executeCommand('omp.inspectStorage');
  const document = vscode.window.activeTextEditor!.document;
  assert.equal(document.uri.scheme, 'omp-storage');
  assert.equal(document.isDirty, false);
  const report = JSON.parse(document.getText());
  return { sessionCount: report.sessionCount, serializedStateBytes: report.serializedStateBytes };
}

export async function nativeInstalledOnboarding(root: vscode.Uri): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-installed-onboarding-'));
  const config = vscode.workspace.getConfiguration('omp');
  const baseline = await publicStorage();
  const target = path.join(root.fsPath, 'baseline.json');
  const control = path.join(root.fsPath, 'unrelated.json');
  const bytes = [await readFile(target), await readFile(control)];
  try {
    for (const [kind, flag, hint] of startupCases) {
      await config.update(
        'executablePath',
        await startupExecutable(directory, kind, flag),
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('omp.newSession');
      assert.deepEqual(await publicStorage(), baseline);
      assert.deepEqual(await readFile(target), bytes[0]);
      assert.deepEqual(await readFile(control), bytes[1]);
      await checkpoint(root.fsPath, kind, hint);
    }
    await config.update(
      'executablePath',
      process.env.OMP_EXECUTABLE,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand('omp.newSession');
    await checkpoint(root.fsPath, 'connected', 'Model');
    assert.deepEqual(await readFile(target), bytes[0]);
    assert.deepEqual(await readFile(control), bytes[1]);
    console.log(
      'PASS: registry-installed production package public storage/onboarding/retry, visible model controls, preserved fixture bytes and zero prompt generation; no harness-only API used.',
    );
  } finally {
    await config.update(
      'executablePath',
      process.env.OMP_EXECUTABLE,
      vscode.ConfigurationTarget.Global,
    );
    await rm(directory, { recursive: true, force: true });
  }
}
