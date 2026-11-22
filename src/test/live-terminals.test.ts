import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, Turn } from '../state.js';
register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { assertTerminalPrivacy, assertNativeTerminalPrivacy } = await import('./live-terminals.js');
const { assertTaskEvidence, taskEvidenceStart } = await import('./live-tasks.js');
const {
  assertCompactionFile,
  compactionFixtures,
  replayContext,
  seedWorkspaceInstructions,
  workspaceInstructionWorkflow,
} = await import('./live-mixed-session.js');

test('instruction workflow requires immutable capture, silent resume and both explicit refusals', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-instruction-flow-'));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const file = path.join(directory, 'observer.json');
  const previous = process.env.VS_OMP_LIVE_REPORT;
  process.env.VS_OMP_LIVE_REPORT = file;
  context.after(async () => {
    if (previous === undefined) delete process.env.VS_OMP_LIVE_REPORT;
    else process.env.VS_OMP_LIVE_REPORT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await seedWorkspaceInstructions(root);
  let captured = await readFile(path.join(root, '.omp/AGENTS.md'), 'utf8');
  const report = { requests: [] as object[], tools: [] as { name: string }[], processStarts: 1 };
  const refusals: (boolean | 'file' | 'command')[] = [];
  const api = {
    status: () => ({ sessionId: 'unit-owner', changes: [] }),
    request: async (request: { type: string }) => {
      if (request.type === 'resumeSession') {
        captured = await readFile(path.join(root, '.omp/AGENTS.md'), 'utf8');
        report.processStarts++;
        await writeFile(file, JSON.stringify(report));
      }
    },
  };
  const prompt = async (
    _text: string,
    _approve: unknown,
    refused: boolean | 'file' | 'command' = false,
  ) => {
    refusals.push(refused);
    report.requests.push({});
    if (refused === 'command') report.tools.push({ name: 'bash' });
    await writeFile(file, JSON.stringify(report));
    return refused ? 'Permission refused.' : captured;
  };
  await writeFile(file, JSON.stringify(report));
  await workspaceInstructionWorkflow(api as any, root, prompt);
  assert.deepEqual(refusals, [false, false, false, 'file', 'command']);
  assert.equal(report.requests.length, 5);
  await assert.rejects(
    workspaceInstructionWorkflow(api as any, root, prompt),
    /Instruction discovery must not start inference/,
  );
});

function replayFixture() {
  const state = {
    sessionId: 'unit-owner',
    attachments: [] as Attachment[],
    turns: [] as Turn[],
    changes: [],
  };
  const observed: string[][] = [];
  const api = {
    status: () => state,
    storedState: () => ({ sessions: [{ id: state.sessionId, turns: state.turns }] }),
    attachSnapshots: async (snapshots: Attachment[]) => {
      state.attachments = snapshots.map((snapshot, index) => ({
        ...snapshot,
        id: `unit-${index}`,
      }));
    },
    request: async (request: { type: string; id: string; text?: string }) => {
      if (request.type === 'removeAttachment')
        state.attachments = state.attachments.filter((snapshot) => snapshot.id !== request.id);
      else {
        const turn = state.turns.find((entry) => entry.id === request.id)!;
        turn.id = 'unit-replayed-turn';
        turn.prompt = request.text!;
      }
    },
  };
  const prompt = async (text: string) => {
    observed.push(state.attachments.map((snapshot) => snapshot.label));
    const snapshots = structuredClone(state.attachments);
    const answer =
      snapshots.find((snapshot) => snapshot.label === 'v01-reference-0.txt')?.text ??
      'Ready for handoff';
    state.turns.push({
      id: `unit-turn-${state.turns.length}`,
      prompt: text,
      status: 'completed',
      startedAt: 0,
      attachments: snapshots,
      blocks: [{ id: 'unit-answer', kind: 'text', text: answer }],
    });
    state.attachments = [];
    return answer;
  };
  return { api, prompt, observed };
}

test('mixed history replays the owned reference before population and leaves only the handoff note pending', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-mixed-order-'));
  const file = path.join(root, 'unit-observer.json');
  const previous = process.env.VS_OMP_LIVE_REPORT;
  process.env.VS_OMP_LIVE_REPORT = file;
  context.after(async () => {
    if (previous === undefined) delete process.env.VS_OMP_LIVE_REPORT;
    else process.env.VS_OMP_LIVE_REPORT = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(file, JSON.stringify({ requests: [], tools: [], processStarts: 1 }));
  const fixture = replayFixture();
  const result = await replayContext(fixture.api as any, root, fixture.prompt);
  assert.deepEqual(fixture.observed[0], ['v01-reference-0.txt']);
  assert.deepEqual(fixture.observed[1], [
    'v01-archived-records-0.json',
    'v01-archived-records-1.json',
  ]);
  assert.equal(fixture.api.status().turns[0]!.id, 'unit-replayed-turn');
  assert.equal(fixture.api.status().attachments.length, 1);
  assert.equal(fixture.api.status().attachments[0]!.label, 'v01-reference-2.txt');
  assert.equal(JSON.stringify(fixture.api.status().attachments) === result.pending, true);
});

test('mixed task evidence isolates its segment but cannot waive failed exits or foreign tools', () => {
  const tools = [
    { name: 'editor', input: '{"action":"tasks"}' },
    ...Array.from({ length: 5 }, () => ({ name: 'task', input: '{}' })),
  ];
  const results = [1, 0, 1, 1].map((exitCode) => ({
    name: 'task',
    isError: false,
    content: JSON.stringify([
      {
        text: JSON.stringify({
          exitStatus: { exitCode },
          output: exitCode === 0 ? 'TASK_WORKFLOW_PASSED' : 'failed',
        }),
      },
    ]),
  }));
  results.push({ name: 'task', isError: true, content: 'cancelled' });
  const report = {
    tools: [{ name: 'ask', input: '{}' }, ...tools],
    results: [{ name: 'other', isError: true, content: 'earlier failure' }, ...results],
  };
  assertTaskEvidence(report, { tools: 1, results: 1 });
  assert.throws(() => assertTaskEvidence(report));
  const review = { tools: report.tools.slice(0, -2), results: report.results.slice(0, -2) };
  assertTaskEvidence(review, { tools: 1, results: 1 }, 'review');
  assert.throws(() => assertTaskEvidence(review, { tools: 1, results: 1 }));
  assert.throws(() => assertTaskEvidence(report, { tools: 1, results: 1 }, 'review'));
  assert.throws(() =>
    assertTaskEvidence(
      { ...report, tools: [...report.tools, { name: 'bash', input: '{}' }] },
      { tools: 1, results: 1 },
    ),
  );
  assert.throws(() =>
    assertTaskEvidence(
      {
        ...report,
        results: [...report.results, { name: 'editor', isError: true, content: 'failed' }],
      },
      { tools: 1, results: 1 },
    ),
  );
});

test('task evidence starts before the first guard write but fails closed on malformed or unreadable reports', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-task-evidence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'observer.json');
  assert.deepEqual(await taskEvidenceStart(file), { tools: 0, results: 0 });
  await writeFile(file, JSON.stringify({ tools: [{}, {}], results: [{}] }));
  assert.deepEqual(await taskEvidenceStart(file), { tools: 2, results: 1 });
  await writeFile(file, '{invalid');
  await assert.rejects(taskEvidenceStart(file), SyntaxError);
  await writeFile(file, '{}');
  await assert.rejects(taskEvidenceStart(file));
  await rm(file);
  await mkdir(file);
  await assert.rejects(taskEvidenceStart(file), { code: 'EISDIR' });
});

test('mixed compaction fixture is a populated bounded immutable structured snapshot', () => {
  const snapshots = compactionFixtures('/disposable-workspace');
  assert.equal(snapshots.length, 2);
  assert.ok(
    snapshots.every((snapshot) => snapshot.kind === 'file' && snapshot.text.length <= 64000),
  );
  const length = snapshots.reduce((sum, snapshot) => sum + snapshot.text.length, 0);
  assert.ok(length >= 100000 && length <= 128000);
  const rows = snapshots.flatMap((snapshot) => JSON.parse(snapshot.text));
  assert.equal(rows.length, 2200);
  assert.deepEqual(rows[0], { row: 0, event: 'Archived checkpoint', value: 7 });
  assert.equal(rows.at(-1).row, 2199);
});

test('mixed history requires an actual committed native summary retaining the handoff value', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-mixed-summary-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'native.jsonl');
  const marker = 'fixture-handoff';
  await writeFile(file, JSON.stringify({ type: 'message', summary: marker, tokensBefore: 5 }));
  await assert.rejects(assertCompactionFile(file, marker));
  await writeFile(file, JSON.stringify({ type: 'compaction', summary: marker, tokensBefore: 5 }));
  await assertCompactionFile(file, marker);
  await assert.rejects(assertCompactionFile(file, 'missing'));
  await writeFile(file, JSON.stringify({ type: 'compaction', summary: marker, tokensBefore: 0 }));
  await assert.rejects(assertCompactionFile(file, marker));
});

test('terminal privacy accepts an absent optional wire log but fails closed on leakage and read errors', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-privacy-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'observer.json');
  const value = 'fixture-only-sensitive-value';
  await assert.rejects(assertTerminalPrivacy(file, value, []), { code: 'ENOENT' });
  await writeFile(file, '{}');
  await assertTerminalPrivacy(file, value, [{ safe: true }]);
  await writeFile(`${file}.wire.jsonl`, '{}');
  await assertTerminalPrivacy(file, value, [{ safe: true }]);
  await assert.rejects(assertTerminalPrivacy(file, value, [{ input: value }]));
  await writeFile(`${file}.wire.jsonl`, value);
  await assert.rejects(assertTerminalPrivacy(file, value, []));
  await writeFile(`${file}.wire.jsonl`, '{}');
  await writeFile(file, value);
  await assert.rejects(assertTerminalPrivacy(file, value, []));
  await writeFile(file, '{}');
  await rm(`${file}.wire.jsonl`);
  await mkdir(`${file}.wire.jsonl`);
  await assert.rejects(assertTerminalPrivacy(file, value, []), { code: 'EISDIR' });
});

test('native terminal privacy requires the actual persisted job and rejects synthetic input', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-terminal-native-privacy-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'User', 'workspaceStorage');
  const native = path.join(root, 'a'.repeat(32), 'vs-omp-local.vs-omp', 'omp-sessions');
  await mkdir(native, { recursive: true });
  await mkdir(path.join(root, 'b'.repeat(32)));
  const value = 'fixture-only-sensitive-input';
  const job = 'actual-owned-fixture-job';
  await assert.rejects(assertNativeTerminalPrivacy(directory, value, job), /actual job ID/);
  const file = path.join(native, 'fixture.jsonl');
  await writeFile(file, JSON.stringify({ job }));
  await assertNativeTerminalPrivacy(directory, value, job);
  await writeFile(file, JSON.stringify({ job, input: value }));
  await assert.rejects(assertNativeTerminalPrivacy(directory, value, job));
  await rm(file);
  await mkdir(file);
  await assert.rejects(assertNativeTerminalPrivacy(directory, value, job), /symlink or special/);
});
