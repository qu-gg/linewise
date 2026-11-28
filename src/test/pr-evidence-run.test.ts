import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPullRequestBody, runCommand } from '../pr-evidence.js';

test('verification command captures stdout, stderr, output bounds and exit status', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7;'],
    process.cwd(),
    new AbortController().signal,
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.truncated, false);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test('verification command stops a running process when its caller aborts', async () => {
  const abort = new AbortController();
  const pending = runCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    process.cwd(),
    abort.signal,
  );
  setTimeout(() => abort.abort(new Error('cancelled')), 50);
  await assert.rejects(pending, /cancelled/);
});

test('PR body keeps captured verification output bounded', () => {
  const body = formatPullRequestBody({
    branch: 'feat/example',
    base: 'origin/main',
    baseSha: 'a'.repeat(40),
    ahead: 1,
    behind: 0,
    script: 'check',
    output: 'x'.repeat(5000),
    truncated: true,
    files: [],
  });
  assert.match(body, /…/);
  assert.ok(body.length < 5000);
});
