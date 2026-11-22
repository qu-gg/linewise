import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { questionRequest } from '../question-policy.js';
import { Questions } from '../questions.js';
import { installNativeQuestions } from '../native-questions.js';
import type { NativeEditApi } from '../native-edit.js';
import { fixture, reset, window, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { askQuestions } = await import('../host-questions.js');
const { HostTools } = await import('../host-tools.js');
const request = (extra = {}) =>
  questionRequest.parse({
    questions: [
      {
        header: 'Format',
        question: 'Choose a format',
        options: [{ label: 'JSON' }, { label: 'Text' }],
        ...extra,
      },
    ],
  });

test('chat questions validate complete exact answers, custom text and once-only owned submission', async () => {
  const questions = new Questions(() => {});
  const pending = questions.request(
    request({ multiSelect: true }),
    new AbortController().signal,
    () => true,
  );
  const id = questions.snapshot().question!.id;
  assert.equal(questions.answer('stale', []), false);
  assert.throws(() => questions.answer(id, []));
  assert.throws(() => questions.answer(id, [{ selected: ['invented'] }]));
  assert.throws(() => questions.answer(id, [{ selected: ['JSON', 'JSON'] }]));
  assert.throws(() => questions.answer(id, [{ selected: [] }]));
  assert.equal(
    questions.answer(id, [{ selected: ['JSON', 'Text'], freeText: 'custom also' }]),
    true,
  );
  assert.equal(questions.answer(id, [{ selected: ['JSON'] }]), false);
  assert.deepEqual(JSON.parse(await pending), {
    status: 'answered',
    answers: { Format: { selected: ['JSON', 'Text'], freeText: 'custom also' } },
  });
  const strict = questions.request(
    request({ allowFreeformInput: false }),
    new AbortController().signal,
    () => true,
  );
  const next = questions.snapshot().question!.id;
  assert.throws(() => questions.answer(next, [{ selected: ['JSON', 'Text'] }]));
  assert.throws(() => questions.answer(next, [{ selected: ['JSON'], freeText: 'not allowed' }]));
  questions.cancel(next);
  assert.equal(JSON.parse(await strict).status, 'cancelled');
});

test('chat questions cancel on stale ownership, Stop and view disposal without reviving or auto-answering', async () => {
  const questions = new Questions(() => {});
  let valid = true;
  const abort = new AbortController();
  const first = questions.request(request(), abort.signal, () => valid);
  const second = questions.request(request(), new AbortController().signal, () => true);
  const id = questions.snapshot().question!.id;
  valid = false;
  assert.equal(questions.answer(id, [{ selected: ['JSON'] }]), false);
  assert.equal(JSON.parse(await first).status, 'cancelled');
  assert.equal(questions.snapshot().questionCount, 1);
  questions.cancel();
  assert.equal(JSON.parse(await second).status, 'cancelled');
  assert.equal(questions.snapshot().question, undefined);
  const stopped = questions.request(request(), abort.signal, () => true);
  abort.abort(new Error('Stopped chat question'));
  await assert.rejects(stopped, /Stopped chat question/);
  await assert.rejects(
    questions.request(request(), abort.signal, () => true),
    /Stopped chat question/,
  );
});

test('questions validate strict bounded unique input', () => {
  assert.equal(request().questions.length, 1);
  for (const input of [
    { questions: [] },
    { questions: Array(5).fill({ header: 'q', question: 'q' }) },
    { questions: [{ header: 'q', question: 'q', command: 'run' }] },
    { questions: [{ header: 'q', question: 'q', allowFreeformInput: false }] },
    {
      questions: [{ header: 'q', question: 'q', options: [{ label: 'same' }, { label: 'same' }] }],
    },
    {
      questions: [
        { header: 'q', question: 'q' },
        { header: 'q', question: 'q' },
      ],
    },
  ])
    assert.equal(questionRequest.safeParse(input).success, false);
});

test('questions return exact single and multiple labels without mutation', async () => {
  reset();
  fixture.quickPick = '0';
  const signal = new AbortController().signal;
  assert.deepEqual(JSON.parse(await askQuestions(request(), signal)), {
    status: 'answered',
    answers: { Format: { selected: ['JSON'] } },
  });
  fixture.resourcePicks = ['JSON', 'Text'];
  assert.deepEqual(
    JSON.parse(await askQuestions(request({ multiSelect: true }), signal)).answers.Format.selected,
    ['JSON', 'Text'],
  );
  assert.equal(fixture.disk.size, 0);
});

test('questions support free text and explicit dismissal', async (context) => {
  reset();
  context.mock.method(window, 'showInputBox', async () => 'User supplied text');
  const signal = new AbortController().signal;
  fixture.quickPick = 'custom';
  assert.deepEqual(JSON.parse(await askQuestions(request(), signal)).answers.Format, {
    selected: [],
    freeText: 'User supplied text',
  });
  fixture.quickPick = undefined;
  assert.deepEqual(JSON.parse(await askQuestions(request(), signal)), {
    status: 'cancelled',
    answers: {},
  });
});

test('Stop rejects a pending native question even if its provider never completes', async (context) => {
  reset();
  context.mock.method(window, 'showQuickPick', () => new Promise(() => {}));
  const abort = new AbortController();
  const pending = askQuestions(request(), abort.signal);
  abort.abort(new Error('Stopped question'));
  await assert.rejects(pending, /Stopped question/);
  await assert.rejects(askQuestions(request(), abort.signal), /Stopped question/);
});

test('freeform-only questions preserve exact input and prototype-like headers safely', async (context) => {
  reset();
  context.mock.method(window, 'showInputBox', async () => 'Exact user answer');
  const parsed = questionRequest.parse({
    questions: [{ header: '__proto__', question: 'Which value?', options: null }],
  });
  const result = JSON.parse(await askQuestions(parsed, new AbortController().signal));
  assert.equal(Object.hasOwn(result.answers, '__proto__'), true);
  assert.equal(result.answers.__proto__.freeText, 'Exact user answer');
  fixture.quickPick = 'custom';
  context.mock.method(window, 'showInputBox', async () => undefined);
  assert.equal(
    JSON.parse(await askQuestions(request(), new AbortController().signal)).status,
    'cancelled',
  );
});

test('registered questions traverse the prompt broker without mutation authority', async (context) => {
  reset();
  fixture.quickPick = '0';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-questions-'));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const previous = process.env.VS_OMP_ARTIFACTS_ROOT;
  context.after(async () => {
    if (previous === undefined) delete process.env.VS_OMP_ARTIFACTS_ROOT;
    else process.env.VS_OMP_ARTIFACTS_ROOT = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeQuestions({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  assert.equal(tool.name, 'ask');
  assert.equal(tool.approval, 'read');
  const abort = new AbortController();
  const execute = (input: unknown = request(), signal?: AbortSignal) =>
    tool.execute(randomUUID(), input, signal, undefined, {
      cwd,
      sessionManager: { getSessionId: () => 'native' },
    });
  delete process.env.VS_OMP_ARTIFACTS_ROOT;
  await assert.rejects(execute(), /storage is unavailable/);
  await assert.rejects(execute({ questions: [] }));
  abort.abort(new Error('Stopped before question dispatch'));
  await assert.rejects(execute(request(), abort.signal), /Stopped before question dispatch/);
  process.env.VS_OMP_ARTIFACTS_ROOT = cwd;
  const forbidden = async (): Promise<never> => {
    throw new Error('No mutation allowed');
  };
  const tools = new HostTools(
    { normalize: forbidden },
    { read: async () => '', write: forbidden },
    path.join(cwd, 'mutations'),
  );
  await tools.run(
    {
      cwd,
      signal: new AbortController().signal,
      sessionId: 'native',
      owner: 'local',
      valid: () => true,
    },
    async () => {
      const result = (await execute()) as { content: { text: string }[]; isError: boolean };
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(result.content[0]!.text), {
        status: 'answered',
        answers: { Format: { selected: ['JSON'] } },
      });
    },
  );
  assert.equal(fixture.disk.size, 0);
});
