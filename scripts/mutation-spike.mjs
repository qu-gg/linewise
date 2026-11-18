import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpClient, selectOptions } from '../dist/acp.js';
import { PathGuard, ReviewJournal } from '../dist/review.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-mutations-'));
const root = path.join(directory, 'workspace');
const artifacts = path.join(directory, 'sessions');
await mkdir(root);
const target = path.join(root, 'greeting.txt');
const outside = path.join(directory, 'outside.txt');
await writeFile(target, 'pre-existing user work\n');
await writeFile(outside, 'private baseline\n');
const files = {
  read: async (target) =>
    readFile(target, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  replace: async (target, expected, content) => {
    assert.equal(await files.read(target), expected);
    if (content === null) await unlink(target);
    else await writeFile(target, content, { flag: expected === null ? 'wx' : 'w' });
  },
};
let allowed = false;
let mediatedWrites = 0;
let approvalRequests = 0;
const journal = new ReviewJournal(
  files,
  new PathGuard([root]),
  async () => {
    approvalRequests++;
    return allowed;
  },
  async () => {},
);
const client = new OmpClient(
  {
    update: async () => {},
    read: async (request) => journal.read(request.path),
    write: async (request) => {
      mediatedWrites++;
      await journal.write(request.sessionId, request.path, request.content);
    },
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  },
  (message) => process.stderr.write(message),
);
const deadline = setTimeout(() => {
  void client.stop();
}, 90_000);

async function prompt(target, content) {
  await client.prompt([
    {
      type: 'text',
      text:
        `Use the write tool exactly once to write ${JSON.stringify(content)} to ${JSON.stringify(target)}. ` +
        'The JSON string describes the exact file contents, not a quoted string to put in the file. ' +
        'Do not retry if denied. Do not use any other writing mechanism. Then reply briefly.',
    },
  ]);
}

try {
  const config = path.join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      memory: { backend: 'mnemopi' },
      mnemopi: {
        dbPath: path.join(directory, 'memory', 'mnemopi.db'),
        noEmbeddings: true,
        llmMode: 'none',
        scoping: 'per-project',
      },
      tools: { xdev: false, approvalMode: 'write' },
    }),
    { mode: 0o600 },
  );
  await client.start({
    executable: process.env.OMP_EXECUTABLE || 'omp',
    cwd: root,
    artifacts,
    args: [
      '--config',
      config,
      '--no-extensions',
      '--extension',
      fileURLToPath(new URL('../dist/omp-guard.js', import.meta.url)),
      '--tools',
      'read,write,todo,retain,recall,memory_edit',
      '--no-lsp',
      '--no-title',
      '--session-dir',
      artifacts,
      '--approval-mode',
      'write',
      '--max-time',
      '60',
    ],
  });
  const model = client.configOptions.find((option) => option.id === 'model');
  assert.ok(
    model && selectOptions(model).some((option) => option.value === 'github-copilot/gpt-4.1'),
  );
  await client.setConfig('model', 'github-copilot/gpt-4.1');
  await prompt(target, 'first agent turn\n');
  assert.equal(await files.read(target), 'first agent turn\n');
  await prompt(target, 'second agent turn\n');
  assert.equal(await files.read(target), 'second agent turn\n');
  assert.equal(journal.list().length, 1);
  assert.equal(journal.list()[0].before, 'pre-existing user work\n');
  await journal.discard(journal.list()[0].id);
  assert.equal(await files.read(target), 'pre-existing user work\n');
  console.log(
    'PASS: real OMP writes are mediated, accumulate across turns, and discard preserves original user work.',
  );
  await prompt(outside, 'must be denied\n');
  assert.equal(await files.read(outside), 'private baseline\n');
  assert.equal(journal.list().length, 0);
  assert.ok(approvalRequests >= 1);
  console.log('PASS: rejected outside-workspace mutation leaves the target and journal unchanged.');
  allowed = true;
  await prompt(outside, 'approved once\n');
  assert.equal(await files.read(outside), 'approved once\n');
  assert.equal(journal.list()[0].before, 'private baseline\n');
  await journal.discard(journal.list()[0].id);
  assert.equal(await files.read(outside), 'private baseline\n');
  console.log('PASS: approved outside-workspace writes remain reviewable and reversible.');
  const memoryFiles = await readdir(path.join(directory, 'memory'), { recursive: true });
  assert.ok(memoryFiles.some((name) => name.endsWith('.db')));
  console.log('PASS: local-only memory database was initialized.');
  console.log(
    JSON.stringify({ mediatedWrites, approvalRequests, model: 'github-copilot/gpt-4.1' }),
  );
} finally {
  clearTimeout(deadline);
  await client.stop();
  await rm(directory, { recursive: true, force: true });
}
