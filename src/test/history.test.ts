import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import installHistory, { exchangeHistory } from '../history.js';
import type { HistoryApi } from '../history.js';

async function fixture(testContext: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-resume-unit-'));
  const control = path.join(root, 'control');
  const artifacts = path.join(root, 'sessions');
  await mkdir(artifacts);
  const previous = {
    control: process.env.VS_OMP_HISTORY_DIR,
    artifacts: process.env.VS_OMP_ARTIFACTS_ROOT,
  };
  process.env.VS_OMP_HISTORY_DIR = control;
  process.env.VS_OMP_ARTIFACTS_ROOT = artifacts;
  testContext.after(async () => {
    for (const [name, value] of [
      ['VS_OMP_HISTORY_DIR', previous.control],
      ['VS_OMP_ARTIFACTS_ROOT', previous.artifacts],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  let handler!: Parameters<HistoryApi['registerCommand']>[1]['handler'];
  installHistory({
    registerCommand: (_name, command) => {
      handler = command.handler;
    },
    appendEntry: () => {},
  });
  const state = { cancelled: false, switches: [] as string[] };
  const context: Parameters<typeof handler>[1] = {
    isIdle: () => true,
    navigateTree: async () => ({ cancelled: state.cancelled }),
    switchSession: async (file) => {
      state.switches.push(file);
      return { cancelled: state.cancelled };
    },
    sessionManager: {
      getSessionId: () => 'native',
      getSessionFile: () => path.join(artifacts, 'good.jsonl'),
      getLeafId: () => null,
      getBranch: () => [],
    },
  };
  const send = async (text: string) => handler(text.split(' ')[1]!, context);
  return { root, control, artifacts, state, context, handler, send };
}

test('private resume accepts only a regular file inside canonical private storage', async (context) => {
  const current = await fixture(context);
  const target = path.join(current.artifacts, 'good.jsonl');
  await writeFile(target, '{}');
  const result = await exchangeHistory(current.control, current.send, {
    action: 'resume',
    fileName: 'good.jsonl',
  });
  assert.equal(result.fileName, 'good.jsonl');
  assert.deepEqual(current.state.switches, [target]);
  const outside = path.join(current.root, 'outside.jsonl');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(current.artifacts, 'escape.jsonl'));
  await mkdir(path.join(current.artifacts, 'directory.jsonl'));
  for (const fileName of ['escape.jsonl', 'directory.jsonl'])
    await assert.rejects(
      exchangeHistory(current.control, current.send, { action: 'resume', fileName }),
      /escaped private storage/,
    );
  assert.equal(current.state.switches.length, 1);
  assert.deepEqual(await readdir(current.control), []);
});

test('private resume cancellation and unavailable session switching fail closed', async (context) => {
  const current = await fixture(context);
  await writeFile(path.join(current.artifacts, 'good.jsonl'), '{}');
  current.state.cancelled = true;
  await assert.rejects(
    exchangeHistory(current.control, current.send, { action: 'resume', fileName: 'good.jsonl' }),
    /cancelled/,
  );
  delete current.context.switchSession;
  await assert.rejects(
    exchangeHistory(current.control, current.send, { action: 'resume', fileName: 'good.jsonl' }),
    /unavailable/,
  );
  assert.deepEqual(await readdir(current.control), []);
});

test('history exchange rejects mismatched and oversized replies and cleans every temporary file', async (context) => {
  const current = await fixture(context);
  for (const oversized of [false, true]) {
    const send = async (text: string) => {
      const id = text.split(' ')[1]!;
      assert.equal(
        (await stat(path.join(current.control, `request-${id}.json`))).mode & 0o777,
        0o600,
      );
      const response = oversized
        ? 'x'.repeat(2 * 1024 * 1024 + 1)
        : JSON.stringify({
            id: randomUUID(),
            ok: true,
            snapshot: { sessionId: 'native', leafId: null, entries: [] },
          });
      await writeFile(path.join(current.control, `response-${id}.json`), response);
    };
    await assert.rejects(
      exchangeHistory(current.control, send, { action: 'inspect' }),
      oversized ? /exceeds/ : /identity mismatch/,
    );
    assert.deepEqual(await readdir(current.control), []);
  }
});

test('history handler rejects oversized request files before parsing their payload', async (context) => {
  const current = await fixture(context);
  await mkdir(current.control);
  const id = randomUUID();
  await writeFile(path.join(current.control, `request-${id}.json`), 'x'.repeat(4097));
  await current.handler(id, current.context);
  const reply = JSON.parse(
    await readFile(path.join(current.control, `response-${id}.json`), 'utf8'),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error, /request exceeds/);
});

for (const refusal of ['cancelled', 'hook-error', 'summary-injection']) {
  test(`native history ${refusal} refuses continuation and cleans its private exchange`, async (context) => {
    const current = await fixture(context);
    const entries = [
      { id: 'past', parentId: null, type: 'message', message: { role: 'user' } },
      { id: 'future', parentId: 'past', type: 'message', message: { role: 'user' } },
    ];
    current.context.sessionManager.getBranch = () => entries;
    current.context.sessionManager.getLeafId = () => entries.at(-1)!.id;
    current.context.navigateTree = async (_target, options) => {
      assert.deepEqual(options, { summarize: false });
      if (refusal === 'hook-error') throw new Error('fixture hook refused');
      if (refusal === 'summary-injection') {
        entries.splice(1, 1, {
          id: 'summary',
          parentId: 'past',
          type: 'branch_summary',
          message: { role: 'assistant' },
        });
      }
      return { cancelled: refusal === 'cancelled' };
    };
    await assert.rejects(
      exchangeHistory(current.control, current.send, {
        action: 'navigate',
        sessionId: 'native',
        leafId: 'future',
        entryId: 'future',
      }),
      /cancelled|hook refused|exact requested prefix/,
    );
    assert.deepEqual(await readdir(current.control), []);
    assert.equal(current.state.switches.length, 0);
  });
}
