import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installLiveTransport } from './live-transport.mjs';

export function liveSettings(environment = process.env) {
  assert.equal(environment.VS_OMP_LIVE_TESTS, '1', 'Live inference requires explicit opt-in.');
  const model = environment.VS_OMP_LIVE_MODEL;
  assert.match(model ?? '', /^github-copilot\/[\w.-]+$/, 'An exact Copilot model is required.');
  const scenario = environment.VS_OMP_LIVE_CASE ?? 'all';
  assert.ok(
    [
      'all',
      'resources',
      'tasks',
      'task-graphs',
      'web-tasks',
      'terminal-handoff',
      'code-actions',
      'retrieval-refactor',
      'notebook-images',
      'notebook-review',
      'image-context',
      'image-formats',
      'rename',
      'readout',
      'shell',
      'outside',
      'browser',
      'owned-browser',
      'browser-session',
      'workspace-symbols',
      'editor',
      'questions',
      'mixed-questions',
      'mixed-session',
      'mixed-history',
      'instructions',
    ].includes(scenario),
    'Unknown live scenario.',
  );
  const bounded = (key, fallback, maximum) => {
    const value = Number(environment[key] ?? fallback);
    assert.ok(Number.isInteger(value) && value > 0 && value <= maximum, `Invalid ${key}.`);
    return value;
  };
  const seconds = bounded('VS_OMP_LIVE_SECONDS', 90, 180);
  assert.ok(
    environment.VS_OMP_LIVE_TRANSPORT === undefined || environment.VS_OMP_LIVE_TRANSPORT === '1',
    'Invalid live transport opt-in.',
  );
  return {
    model,
    scenario,
    requests: bounded('VS_OMP_LIVE_REQUESTS', 16, 20),
    tools: bounded('VS_OMP_LIVE_TOOLS', 32, 48),
    tokens: bounded('VS_OMP_LIVE_TOKENS', 2048, 4096),
    seconds,
    runSeconds: bounded('VS_OMP_LIVE_RUN_SECONDS', seconds * 6, 1080),
    ...(environment.VS_OMP_LIVE_TRANSPORT === '1' ? { transport: 'http' } : {}),
  };
}

function needsLiveConfig(args, limits) {
  return args[0] === 'acp' && (limits.scenario === 'mixed-history' || limits.transport === 'http');
}

export async function liveArguments(args, limits, profile) {
  if (!needsLiveConfig(args, limits)) return args;
  assert.ok(profile, 'Generated compaction requires an owned disposable profile.');
  const index = args.indexOf('--config');
  assert.ok(index >= 0 && args[index + 1], 'A private session config is required.');
  const root = await realpath(profile);
  const source = await realpath(args[index + 1]);
  const relative = path.relative(root, source);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Live compaction config must stay inside its disposable profile.',
  );
  const config = JSON.parse(await readFile(source, 'utf8'));
  assert.ok(config && typeof config === 'object' && !Array.isArray(config));
  if (limits.scenario === 'mixed-history')
    config.compaction = { ...config.compaction, methodOrder: ['soft'] };
  if (limits.transport === 'http')
    config.providers = {
      ...config.providers,
      openaiResponsesWebsockets: false,
      openaiWebsockets: 'off',
    };
  const target = path.join(path.dirname(source), `live-compaction-${randomUUID()}.json`);
  await writeFile(target, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  return args.map((argument, position) => (position === index + 1 ? target : argument));
}

export function boundedPayload(payload, api, limit) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  if (api.includes('responses')) return { ...payload, max_output_tokens: limit };
  if (api.includes('anthropic')) return { ...payload, max_tokens: limit };
  if (api.includes('google'))
    return {
      ...payload,
      generationConfig: { ...payload.generationConfig, maxOutputTokens: limit },
    };
  if (api.includes('completions')) return { ...payload, max_completion_tokens: limit };
  throw new Error('Unsupported live-test provider payload; no unbounded request is allowed.');
}

function reportWriter(file, report) {
  let pending = Promise.resolve();
  return () => {
    const snapshot = JSON.stringify(report);
    pending = pending.then(async () => {
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return pending;
  };
}

function existingReport(file, limits) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return {
        limits,
        startedAt: Date.now(),
        requests: [],
        tools: [],
        results: [],
        refused: [],
        usage: [],
        processStarts: 1,
      };
    throw error;
  }
  assert.ok(Buffer.byteLength(text) <= 1_048_576, 'Live report exceeds its bound.');
  const report = JSON.parse(text);
  assert.deepEqual(report.limits, limits, 'Live report limits changed across restart.');
  assert.ok(Number.isSafeInteger(report.startedAt) && report.startedAt <= Date.now());
  for (const key of ['requests', 'tools', 'results', 'refused', 'usage'])
    assert.ok(Array.isArray(report[key]), `Invalid live report ${key}.`);
  assert.ok(report.requests.length <= limits.requests && report.tools.length <= limits.tools);
  assert.ok(Number.isSafeInteger(report.processStarts) && report.processStarts >= 1);
  assert.ok(report.requests.every((request) => request.model === limits.model));
  report.processStarts++;
  return report;
}

function remainingBudget(report) {
  return Math.max(0, report.startedAt + report.limits.runSeconds * 1000 - Date.now());
}

function requestAllowed(report, model) {
  return (
    model === report.limits.model &&
    report.requests.length < report.limits.requests &&
    remainingBudget(report) > 0
  );
}

function refuseRequest(report, context, reason) {
  report.refused.push(reason);
  void context.abort();
  return reason;
}

function refuseUnobservedCompaction(api, report, save, transport) {
  api.on('session_before_compact', async (_event, context) => {
    const model = context?.model;
    if (
      transport?.active() &&
      requestAllowed(report, `${model?.provider}/${model?.id}`) &&
      ['openai-completions', 'openai-responses'].includes(model?.api)
    )
      return;
    report.refused.push('Native summary requests bypass the live provider guard.');
    await save();
    return { cancel: true };
  });
}

function observeProviderRequests(api, report, save, transport) {
  const { limits } = report;
  api.on('before_provider_request', async (event, context) => {
    const model = `${context.model?.provider}/${context.model?.id}`;
    if (!requestAllowed(report, model) || (transport && !transport.active())) {
      const reason = refuseRequest(
        report,
        context,
        'Live model identity or request budget refused.',
      );
      await save();
      throw new Error(reason);
    }
    let payload;
    try {
      payload = boundedPayload(event.payload, context.model.api, limits.tokens);
    } catch (error) {
      refuseRequest(report, context, 'Unsupported live request payload.');
      await save();
      throw error;
    }
    if (!transport)
      report.requests.push({
        model,
        api: context.model.api,
        at: Date.now(),
        maxOutputTokens: limits.tokens,
      });
    await save();
    return payload;
  });
}

export default function installLiveGuard(api, environment = process.env) {
  const limits = liveSettings(environment);
  const file = environment.VS_OMP_LIVE_REPORT;
  assert.ok(file, 'A private live report destination is required.');
  const report = existingReport(file, limits);
  const save = reportWriter(file, report);
  const transport = installLiveTransport(report, save);
  let deadline;
  observeProviderRequests(api, report, save, transport);
  api.on('before_agent_start', async (_event, context) => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => {
        refuseRequest(report, context, 'Live prompt deadline exceeded.');
        void save();
      },
      Math.min(limits.seconds * 1000, remainingBudget(report)),
    );
    await save();
  });
  api.on('tool_call', async (event, context) => {
    if (report.tools.length >= limits.tools) {
      const reason = refuseRequest(report, context, 'Live tool budget exceeded.');
      await save();
      return { block: true, reason };
    }
    report.tools.push({
      name: event.toolName,
      idHash: createHash('sha256').update(event.toolCallId).digest('hex'),
      idLength: event.toolCallId.length,
      input: JSON.stringify(event.input).slice(0, 8192),
    });
    await save();
  });
  api.on('tool_result', async (event) => {
    report.results.push({
      name: event.toolName,
      isError: event.isError,
      imageCount: event.content.filter((block) => block.type === 'image').length,
      content: JSON.stringify(event.content).slice(0, 4096),
    });
    await save();
  });
  api.on('agent_end', async (event) => {
    clearTimeout(deadline);
    report.usage = event.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => ({
        model: message.model,
        usage: message.usage,
        stopReason: message.stopReason,
      }));
    await save();
  });
  refuseUnobservedCompaction(api, report, save, transport);
  api.on('session_shutdown', () => {
    clearTimeout(deadline);
    transport?.restore();
  });
  return save().catch((error) => {
    transport?.restore();
    throw error;
  });
}
