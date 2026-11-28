import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { register } from 'node:module';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-pr-loader.js', import.meta.url), import.meta.url);
const vscode = await import('vscode');
const { preparePullRequest } = await import('../pr-prepare.js');
const execute = promisify(execFile);
const errors: string[] = [];

Object.assign(vscode.window, {
  withProgress: async (
    _options: unknown,
    task: (
      progress: { report(value: { message?: string }): void },
      token: {
        onCancellationRequested(listener: () => void): void;
        isCancellationRequested: boolean;
      },
    ) => Promise<unknown>,
  ) => task({ report() {} }, { onCancellationRequested() {}, isCancellationRequested: false }),
  showErrorMessage: async (message: string) => {
    errors.push(message);
    return undefined;
  },
});

async function repository(context: TestContext, dirty = false) {
  reset();
  errors.length = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), 'linewise-pr-command-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await execute('git', ['init', '-b', 'main'], { cwd: root });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { check: 'node -e "console.log(\'checks passed\')"' },
    }),
  );
  await execute('git', ['add', 'package.json'], { cwd: root });
  await execute(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
    { cwd: root },
  );
  await execute('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
  await execute('git', ['switch', '-c', 'feat/test'], { cwd: root });
  if (dirty) await writeFile(path.join(root, 'dirty.txt'), 'dirty');
  fixture.roots = [{ name: 'workspace', uri: Uri.file(root), index: 0 }];
  return root;
}

test(
  'prepare pull request copies verification evidence and opens a body',
  { timeout: 15000 },
  async (context) => {
    await repository(context);
    const output = vscode.window.createOutputChannel('test');
    await preparePullRequest(output);
    assert.deepEqual(errors, []);
    assert.match(fixture.clipboard, /## Verification/);
    assert.match(fixture.clipboard, /npm run check/);
    assert.match(fixture.clipboard, /checks passed/);
    assert.equal(fixture.documents.length, 1);
  },
);

test(
  'prepare pull request reports a dirty branch without opening a body',
  { timeout: 15000 },
  async (context) => {
    await repository(context, true);
    const output = vscode.window.createOutputChannel('test');
    await preparePullRequest(output);
    assert.equal(fixture.documents.length, 0);
    assert.match(errors[0] ?? '', /Commit or stash/);
  },
);
