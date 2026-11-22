import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import installLiveGuard, {
  boundedPayload,
  liveArguments,
  liveSettings,
} from '../scripts/live-guard.mjs';
import { inlineJson, recordedFixture } from '../scripts/preview-data.mjs';
import { installFixtureGuard } from '../scripts/fixture-guard.mjs';

const enabled = { VS_OMP_LIVE_TESTS: '1', VS_OMP_LIVE_MODEL: 'github-copilot/gpt-6-luna' };

test('native fixture guards refuse missing, foreign and normal models before generation or provider requests', () => {
  const handlers = new Map();
  installFixtureGuard({ on: (name, handler) => handlers.set(name, handler) });
  assert.deepEqual([...handlers.keys()], ['before_agent_start', 'before_provider_request']);
  let aborted = 0;
  const abort = () => {
    aborted++;
  };
  const payload = { synthetic: true };
  for (const handler of handlers.values()) {
    assert.equal(
      handler({ payload }, { model: { provider: 'vs-omp-fixture', id: 'history' }, abort }),
      payload,
    );
    for (const model of [
      undefined,
      { provider: 'vs-omp-fixture', id: 'other' },
      { provider: 'github-copilot', id: 'history' },
      { provider: 'github-copilot', id: 'gpt-4.1' },
    ])
      assert.throws(() => handler({ payload }, { model, abort }), /non-scripted/);
  }
  assert.equal(aborted, 8);
  assert.deepEqual(payload, { synthetic: true });
});

test('recorded test chats are bounded read-only replays without thought blocks or script injection', () => {
  const attack = '</script><script>globalThis.leaked=true</script>';
  const turns = [
    {
      prompt: attack,
      status: 'completed',
      blocks: [
        { kind: 'thought', text: 'PRIVATE_THOUGHT' },
        { kind: 'text', text: attack, secret: 'UNRETAINED_METADATA' },
      ],
    },
  ];
  const result = recordedFixture({ busy: true, changes: ['old'] }, turns);
  assert.equal(result.busy, false);
  assert.deepEqual(result.changes, []);
  assert.equal(result.turns[0].blocks.length, 1);
  const embedded = inlineJson(result);
  assert.equal(embedded.includes('<'), false);
  assert.doesNotMatch(embedded, /PRIVATE_THOUGHT|UNRETAINED_METADATA/);
  assert.equal(JSON.parse(embedded).turns[0].prompt, attack);
  assert.throws(() => recordedFixture({}, []));
  assert.throws(() => recordedFixture({}, Array(41).fill(turns[0])));
  assert.throws(() => recordedFixture({}, [{ ...turns[0], prompt: 'x'.repeat(64001) }]));
  assert.throws(() =>
    recordedFixture({}, [{ ...turns[0], blocks: [{ kind: 'text', text: 'x'.repeat(8193) }] }]),
  );
});

test('live inference requires opt-in, an exact model and bounded limits', () => {
  assert.throws(() => liveSettings({}));
  assert.throws(() => liveSettings({ VS_OMP_LIVE_TESTS: '1' }));
  assert.throws(() => liveSettings({ ...enabled, VS_OMP_LIVE_MODEL: 'automatic' }));
  assert.throws(() => liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'outside-typo' }));
  for (const key of [
    'VS_OMP_LIVE_REQUESTS',
    'VS_OMP_LIVE_TOOLS',
    'VS_OMP_LIVE_TOKENS',
    'VS_OMP_LIVE_SECONDS',
    'VS_OMP_LIVE_RUN_SECONDS',
  ])
    for (const value of ['0', '-1', 'Infinity', '1.5', '999999'])
      assert.throws(() => liveSettings({ ...enabled, [key]: value }));
  assert.equal(liveSettings(enabled).requests, 16);
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'retrieval-refactor' }).scenario,
    'retrieval-refactor',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'instructions' }).scenario,
    'instructions',
  );
  assert.equal(liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'editor' }).scenario, 'editor');
  assert.equal(liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'questions' }).scenario, 'questions');
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'mixed-questions' }).scenario,
    'mixed-questions',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'mixed-session' }).scenario,
    'mixed-session',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'mixed-history' }).scenario,
    'mixed-history',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'browser-session' }).scenario,
    'browser-session',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'workspace-symbols' }).scenario,
    'workspace-symbols',
  );
  assert.equal(liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'web-tasks' }).scenario, 'web-tasks');
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'terminal-handoff' }).scenario,
    'terminal-handoff',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'notebook-review' }).scenario,
    'notebook-review',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'image-context' }).scenario,
    'image-context',
  );
  assert.equal(
    liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'code-actions' }).scenario,
    'code-actions',
  );
});

test('mixed history pins generated compaction in an owned private config without changing defaults or source', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-compaction-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  const source = path.join(profile, 'session-config.json');
  const config = { memory: { backend: 'mnemopi' }, compaction: { keepRecentTokens: 16384 } };
  await writeFile(source, JSON.stringify(config));
  const args = ['acp', '--config', source, '--no-title'];
  const limits = liveSettings({ ...enabled, VS_OMP_LIVE_CASE: 'mixed-history' });
  const selected = await liveArguments(args, limits, profile);
  const target = selected[2];
  assert.equal(path.dirname(target), profile);
  assert.notEqual(target, source);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
    ...config,
    compaction: { keepRecentTokens: 16384, methodOrder: ['soft'] },
  });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(await readFile(source, 'utf8'), JSON.stringify(config));
  assert.deepEqual(args, ['acp', '--config', source, '--no-title']);
  assert.deepEqual(
    selected.filter((_, index) => index !== 2),
    ['acp', '--config', '--no-title'],
  );
  assert.equal(await liveArguments(args, liveSettings(enabled)), args);
  const preflight = ['config', 'get', 'memory.backend', '--json'];
  assert.equal(await liveArguments(preflight, limits), preflight);
  await assert.rejects(liveArguments(args, limits), /owned disposable/);
  await assert.rejects(liveArguments(['acp'], limits, profile), /private session config/);
  const outside = path.join(directory, 'outside.json');
  await writeFile(outside, '{}');
  await assert.rejects(
    liveArguments(['acp', '--config', outside], limits, profile),
    /disposable profile/,
  );
  const link = path.join(profile, 'linked.json');
  await symlink(outside, link);
  await assert.rejects(
    liveArguments(['acp', '--config', link], limits, profile),
    /disposable profile/,
  );
  assert.equal(await readFile(outside, 'utf8'), '{}');
});

test('live payload limits cover supported APIs and reject unknown payloads', () => {
  const payload = { model: 'example', messages: [] };
  assert.equal(boundedPayload(payload, 'openai-responses', 100).max_output_tokens, 100);
  assert.equal(boundedPayload(payload, 'openai-completions', 100).max_completion_tokens, 100);
  assert.equal(boundedPayload(payload, 'anthropic-messages', 100).max_tokens, 100);
  assert.equal(
    boundedPayload(payload, 'google-generative-ai', 100).generationConfig.maxOutputTokens,
    100,
  );
  assert.throws(() => boundedPayload(payload, 'unknown', 100));
  assert.throws(() => boundedPayload(null, 'openai-responses', 100));
  assert.equal(payload.max_output_tokens, undefined);
});

test('live observer cancels excess requests and tools without registering a simulated provider', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-guard-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  const handlers = new Map();
  await installLiveGuard(
    { on: (name, handler) => handlers.set(name, handler) },
    { ...enabled, VS_OMP_LIVE_REPORT: file, VS_OMP_LIVE_REQUESTS: '1', VS_OMP_LIVE_TOOLS: '1' },
  );
  const startup = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(startup.processStarts, 1);
  assert.equal(startup.requests.length, 0);
  assert.equal(startup.tools.length, 0);
  assert.equal(startup.refused.length, 0);
  let cancelled = 0;
  const native = {
    model: { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses' },
    abort: () => {
      cancelled++;
    },
  };
  await handlers.get('before_agent_start')({}, native);
  try {
    const payload = await handlers.get('before_provider_request')(
      { payload: { model: 'gpt-6-luna' } },
      native,
    );
    assert.equal(payload.max_output_tokens, 2048);
    await assert.rejects(
      handlers.get('before_provider_request')({ payload: {} }, native),
      /budget/,
    );
    const event = { toolName: 'read', toolCallId: 'call_secret-signature', input: { path: '.' } };
    await handlers.get('tool_call')(event, native);
    assert.equal((await handlers.get('tool_call')(event, native)).block, true);
    assert.equal(cancelled, 2);
    const report = await readFile(file, 'utf8');
    assert.doesNotMatch(report, /call_secret-signature/);
    assert.equal(JSON.parse(report).requests.length, 1);
  } finally {
    handlers.get('session_shutdown')();
  }
});

test('live observer refuses unobservable native compaction before any summary generation', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-compaction-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  const handlers = new Map();
  const api = { on: (name, handler) => handlers.set(name, handler) };
  const environment = { ...enabled, VS_OMP_LIVE_REPORT: file, VS_OMP_LIVE_CASE: 'mixed-history' };
  await installLiveGuard(api, environment);
  let generations = 0;
  const result = await handlers.get('session_before_compact')({
    preparation: { messagesToSummarize: [{ content: 'UNTRUSTED_COMPACTION_PROBE' }] },
  });
  if (!result?.cancel) generations++;
  assert.deepEqual(result, { cancel: true });
  assert.equal(generations, 0);
  const text = await readFile(file, 'utf8');
  assert.doesNotMatch(text, /UNTRUSTED_COMPACTION_PROBE/);
  const report = JSON.parse(text);
  assert.equal(report.requests.length, 0);
  assert.equal(report.tools.length, 0);
  assert.deepEqual(report.refused, ['Native summary requests bypass the live provider guard.']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  handlers.get('session_shutdown')();
  await installLiveGuard(api, environment);
  const resumed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(resumed.processStarts, 2);
  assert.deepEqual(resumed.refused, report.refused);
  handlers.get('session_shutdown')();
});

test('live observer keeps cumulative request and tool budgets across OMP restarts and refuses corrupt or changed limits', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-restart-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  const environment = {
    ...enabled,
    VS_OMP_LIVE_REPORT: file,
    VS_OMP_LIVE_REQUESTS: '2',
    VS_OMP_LIVE_TOOLS: '1',
  };
  const handlers = new Map();
  const api = { on: (name, handler) => handlers.set(name, handler) };
  let cancelled = 0;
  const native = {
    model: { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses' },
    abort: () => {
      cancelled++;
    },
  };
  installLiveGuard(api, environment);
  await handlers.get('before_provider_request')({ payload: {} }, native);
  await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'original', input: {} }, native);
  handlers.get('session_shutdown')();
  installLiveGuard(api, environment);
  await handlers.get('before_provider_request')({ payload: {} }, native);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.processStarts, 2);
  assert.equal(saved.requests.length, 2);
  assert.equal(saved.tools.length, 1);
  await assert.rejects(handlers.get('before_provider_request')({ payload: {} }, native), /budget/);
  assert.equal(
    (await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'new', input: {} }, native))
      .block,
    true,
  );
  assert.equal(cancelled, 2);
  assert.throws(
    () => installLiveGuard(api, { ...environment, VS_OMP_LIVE_REQUESTS: '3' }),
    /limits changed/,
  );
  await writeFile(file, '{}');
  assert.throws(() => installLiveGuard(api, environment));
  await writeFile(file, '{');
  assert.throws(() => installLiveGuard(api, environment));
});

test('live aggregate time budget is retained and enforced after restart without inference', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-live-clock-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  const environment = {
    ...enabled,
    VS_OMP_LIVE_REPORT: file,
    VS_OMP_LIVE_RUN_SECONDS: '1',
  };
  const handlers = new Map();
  const api = { on: (name, handler) => handlers.set(name, handler) };
  let cancelled = 0;
  const native = {
    model: { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses' },
    abort: () => cancelled++,
  };
  installLiveGuard(api, environment);
  await handlers.get('before_provider_request')({ payload: {} }, native);
  const report = JSON.parse(await readFile(file, 'utf8'));
  report.startedAt = Date.now() - 2000;
  await writeFile(file, JSON.stringify(report));
  installLiveGuard(api, environment);
  await assert.rejects(handlers.get('before_provider_request')({ payload: {} }, native), /budget/);
  assert.equal(cancelled, 1);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.startedAt, report.startedAt);
  assert.equal(saved.processStarts, 2);
  assert.equal(saved.requests.length, 1);
});
