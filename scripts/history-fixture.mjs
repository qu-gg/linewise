import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeInput, nativePlans } from './native-plans.mjs';

function nativeMutation(context) {
  const userIndex = context.messages.findLastIndex((message) => message.role === 'user');
  const latest = JSON.stringify(context.messages[userIndex]);
  if (!process.env.VS_OMP_FIXTURE_NATIVE || !latest.includes('NATIVE_MUTATION_FIXTURE'))
    return null;
  const replies = context.messages
    .slice(userIndex + 1)
    .filter((message) => message.role === 'toolResult');
  const name = latest.match(/NATIVE_MUTATION_FIXTURE ([a-z]+)/)?.[1];
  const plan = nativePlans.find((candidate) => candidate.name === name);
  if (!plan) throw new Error(`Unknown native fixture: ${name}`);
  const targets = plan.second
    ? [plan.source ?? 'probe.txt', 'second.txt']
    : [plan.source ?? 'probe.txt'];
  const cycle = targets.length + 1;
  const operation = plan.operations[Math.floor(replies.length / cycle)];
  if (!operation) return;
  const position = replies.length % cycle;
  if (position < targets.length)
    return {
      type: 'toolCall',
      id: randomUUID(),
      name: 'read',
      arguments: { path: targets[position], i: 'inspect fixture' },
    };
  return {
    type: 'toolCall',
    id: randomUUID(),
    name: 'edit',
    arguments: {
      i: 'probe native mediation',
      input: nativeInput(plan, replies.slice(-targets.length), operation),
    },
  };
}

function requestedWrite(latest) {
  const fixtures = [
    { marker: 'WRITE_FIXTURE', path: 'history.txt', content: 'agent version\n' },
    { marker: 'HISTORY_CREATE_FIXTURE', path: 'history-created.txt', content: 'created\n' },
    { marker: 'HISTORY_EDIT_FIXTURE', path: 'history-created.txt', content: 'edited\n' },
  ];
  const selected = fixtures.find((entry) => latest.includes(entry.marker));
  if (selected)
    return { name: 'write', arguments: { path: selected.path, content: selected.content } };
}

function requestedTool(context) {
  const native = nativeMutation(context);
  if (native !== null) return native;
  const userIndex = context.messages.findLastIndex((message) => message.role === 'user');
  if (
    userIndex < 0 ||
    context.messages.slice(userIndex + 1).some((message) => message.role === 'toolResult')
  )
    return;
  const latest = JSON.stringify(context.messages[userIndex]);
  let tool;
  if (latest.includes('HUNK_REVIEW_FIXTURE'))
    tool = {
      name: 'write',
      arguments: {
        path: 'chat-hunks.txt',
        content:
          Array.from({ length: 30 }, (_, index) =>
            index === 2 || index === 23 ? `agent ${index}` : `line ${index}`,
          ).join('\r\n') + '\r\n',
      },
    };
  else {
    tool = requestedWrite(latest);
    if (!tool && latest.includes('BASH_FIXTURE') && process.env.VS_OMP_FIXTURE_BASH)
      tool = { name: 'bash', arguments: { command: process.env.VS_OMP_FIXTURE_BASH } };
  }
  if (tool) return { type: 'toolCall', id: randomUUID(), ...tool };
}

async function fixtureSessionStart() {
  if (process.env.VS_OMP_FIXTURE_PID)
    await writeFile(process.env.VS_OMP_FIXTURE_PID, String(process.pid), { mode: 0o600 });
}

const fixtureModels = [
  {
    id: 'history',
    name: 'Local history fixture',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

async function fixtureBranch(_event, context) {
  await writeFile(
    `${process.env.VS_OMP_FIXTURE_CONTEXT}.branch.json`,
    JSON.stringify(context.sessionManager.getBranch()),
    { mode: 0o600 },
  );
}

function fixtureLifecycle(api) {
  api.on('session_start', fixtureSessionStart);
  api.on('session_compact', fixtureBranch);
  api.on('session_before_tree', (_event, context) => {
    const latest = context.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === 'message' && entry.message.role === 'user');
    if (JSON.stringify(latest ?? {}).includes('HISTORY_HOOK_REFUSAL_FIXTURE'))
      return { cancel: true };
  });
  api.registerCommand('vs-omp-compaction-inspect', {
    description: 'Inspect the disposable fixture session branch',
    handler: fixtureBranch,
  });
}

function fixtureUsage(context) {
  const input = Math.ceil(JSON.stringify(context.messages).length / 4);
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fixtureInterrupted(stream, message, signal) {
  const stop = () => {
    stream.push({
      type: 'error',
      reason: 'aborted',
      error: {
        ...message,
        content: [],
        stopReason: 'aborted',
        errorMessage: 'Fixture interrupted',
      },
    });
    stream.end();
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
}

function fixtureText(context) {
  if (!JSON.stringify(context.messages).includes('FUTURE_SENTINEL')) return 'FIXTURE_REPLY';
  return `FIXTURE_REPLY ${context.tools?.length ? 'FUTURE_SENTINEL' : 'SUMMARY_ONLY_FUTURE_SENTINEL'}`;
}

function fixtureControl(stream, message, context, signal) {
  const latest = JSON.stringify(
    context.tools?.length
      ? context.messages.findLast((entry) => entry.role === 'user')
      : context.messages,
  );
  if (!context.tools?.length && latest.includes('COMPACTION_FAILURE_FIXTURE')) {
    stream.push({
      type: 'error',
      reason: 'error',
      error: {
        ...message,
        content: [],
        stopReason: 'error',
        errorMessage: 'Fixture summarizer refused',
      },
    });
    stream.end();
    return true;
  }
  if (
    latest.includes('HISTORY_INTERRUPT_FIXTURE') ||
    (!context.tools?.length && latest.includes('COMPACTION_CANCEL_FIXTURE'))
  ) {
    fixtureInterrupted(stream, message, signal);
    return true;
  }
  return false;
}

export default function installFixture(api) {
  fixtureLifecycle(api);
  api.registerProvider('vs-omp-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture-only',
    api: 'vs-omp-fixture',
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const usage = fixtureUsage(context);
      const toolCall = context.tools?.length ? requestedTool(context) : undefined;
      const message = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        content: toolCall ? [toolCall] : [{ type: 'text', text: fixtureText(context) }],
        stopReason: toolCall ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      void writeFile(
        process.env.VS_OMP_FIXTURE_CONTEXT ||
          join(process.env.VS_OMP_HISTORY_DIR, 'provider-context.json'),
        JSON.stringify({ ...context, fixtureReply: message.content }),
        { mode: 0o600 },
      ).then(
        () => {
          stream.push({ type: 'start', partial: message });
          if (fixtureControl(stream, message, context, options.signal)) return;
          const content = message.content[0];
          if (toolCall) {
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: JSON.stringify(content.arguments),
              partial: message,
            });
            stream.push({
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall: content,
              partial: message,
            });
          } else {
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: content.text,
              partial: message,
            });
            stream.push({
              type: 'text_end',
              contentIndex: 0,
              content: content.text,
              partial: message,
            });
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
          stream.end();
        },
        (error) => {
          stream.push({
            type: 'error',
            reason: 'error',
            error: { ...message, content: [], stopReason: 'error', errorMessage: error.message },
          });
          stream.end();
        },
      );
      return stream;
    },
    models: fixtureModels,
  });
}
