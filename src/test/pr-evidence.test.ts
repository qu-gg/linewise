import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectPullRequestEvidence,
  formatPullRequestBody,
  verificationScript,
  type GitRunner,
} from '../pr-evidence.js';

async function workspace(context: TestContext, scripts = { check: 'node scripts/check.mjs' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linewise-pr-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

function git(overrides: Partial<Record<string, string>> = {}): GitRunner {
  return async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/example';
    if (args[0] === 'rev-parse') return 'abcdef1234567890';
    if (args[0] === 'rev-list') return overrides.counts ?? '0\t2';
    if (args[0] === 'status') return overrides.status ?? '';
    if (args[0] === 'diff') return overrides.files ?? 'src/a.ts\nsrc/b.ts';
    throw new Error(`Unexpected git ${args.join(' ')}`);
  };
}

test('verification script prefers check, then verify, then test', () => {
  assert.equal(verificationScript({ scripts: { check: 'x', test: 'y' } }), 'check');
  assert.equal(verificationScript({ scripts: { verify: 'x', test: 'y' } }), 'verify');
  assert.equal(verificationScript({ scripts: { test: 'y' } }), 'test');
  assert.throws(() => verificationScript({}), /scripts/);
  assert.throws(() => verificationScript({ scripts: { build: 'x' } }), /check, verify, or test/);
});

test('PR evidence requires a clean, current branch and a passing verification command', async (context) => {
  const root = await workspace(context);
  const evidence = await collectPullRequestEvidence({
    cwd: root,
    signal: new AbortController().signal,
    git: git(),
    run: async (command, args) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['run', 'check']);
      return { exitCode: 0, output: '663 tests passed', truncated: false };
    },
  });
  assert.deepEqual(evidence, {
    branch: 'feat/example',
    base: 'origin/main',
    baseSha: 'abcdef1234567890',
    ahead: 2,
    behind: 0,
    script: 'check',
    output: '663 tests passed',
    truncated: false,
    files: ['src/a.ts', 'src/b.ts'],
  });
  const body = formatPullRequestBody(evidence);
  assert.match(body, /feat\/example/);
  assert.match(body, /npm run check/);
  assert.match(body, /663 tests passed/);
  assert.match(body, /src\/a\.ts/);
});

test('PR evidence refuses dirty worktrees, stale branches and failing checks', async (context) => {
  const root = await workspace(context);
  const signal = new AbortController().signal;
  await assert.rejects(
    collectPullRequestEvidence({
      cwd: root,
      signal,
      git: git({ status: ' M src/a.ts' }),
      run: async () => ({ exitCode: 0, output: '', truncated: false }),
    }),
    /Commit or stash/,
  );
  await assert.rejects(
    collectPullRequestEvidence({
      cwd: root,
      signal,
      git: git({ counts: '1\t2' }),
      run: async () => ({ exitCode: 0, output: '', truncated: false }),
    }),
    /behind origin\/main/,
  );
  await assert.rejects(
    collectPullRequestEvidence({
      cwd: root,
      signal,
      git: git(),
      run: async () => ({ exitCode: 1, output: 'failed test', truncated: false }),
    }),
    /npm run check failed/,
  );
});
