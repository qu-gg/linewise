import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function sessionStart() {
  await writeFile(process.env.VS_OMP_FIXTURE_PID, String(process.pid), { mode: 0o600 });
  const gate = process.env.VS_OMP_FIXTURE_START_GATE;
  if (!gate) return;
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(gate), (_event, file) => {
      if (file === path.basename(gate)) inspect();
    });
    const fail = (error) => {
      watcher.close();
      reject(error);
    };
    const inspect = () => {
      void readFile(gate).then(
        () => {
          watcher.close();
          resolve();
        },
        (error) => {
          if (error.code !== 'ENOENT') fail(error);
        },
      );
    };
    watcher.once('error', fail);
    void writeFile(`${gate}.ready`, 'ready', { mode: 0o600 }).then(inspect, fail);
  });
}

function requested(context) {
  const start = context.messages.findLastIndex((message) => message.role === 'user');
  const replies = context.messages
    .slice(start + 1)
    .filter((message) => message.role === 'toolResult');
  const command = JSON.parse(process.env.VS_OMP_FIXTURE_HANDOFF).command;
  if (!replies.length) return { action: 'start', command, pty: true, visibility: 'background' };
  if (replies.length === 1) return { command: 'printf OTHER_SAFE_WORK' };
  if (replies.length > 4) return;
  const first = replies[0].content.find((block) => block.type === 'text');
  const { jobId } = JSON.parse(first.text);
  if (typeof jobId !== 'string') throw new Error('Actual owned job ID is required.');
  return { action: ['takeover', 'wait', 'stop'][replies.length - 2], jobId };
}

function emit(stream, message) {
  stream.push({ type: 'start', partial: message });
  const content = message.content[0];
  if (content.type === 'toolCall') {
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
    stream.push({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: JSON.stringify(content.arguments),
      partial: message,
    });
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content, partial: message });
  } else {
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: content.text, partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: content.text, partial: message });
  }
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end();
}

export default function install(api) {
  api.on('session_start', sessionStart);
  api.registerProvider('vs-omp-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture-only',
    api: 'vs-omp-fixture',
    models: [
      {
        id: 'history',
        name: 'Scripted terminal transfer fixture',
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      const request = requested(context);
      const message = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: request
          ? [{ type: 'toolCall', id: `call_${randomUUID()}`, name: 'bash', arguments: request }]
          : [{ type: 'text', text: 'FIXTURE_COMPLETE' }],
        stopReason: request ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      void writeFile(
        process.env.VS_OMP_FIXTURE_CONTEXT,
        JSON.stringify({ ...context, fixtureReply: message.content }),
        { mode: 0o600 },
      ).then(
        () => emit(stream, message),
        (error) => {
          stream.push({
            type: 'error',
            reason: 'error',
            error: { ...message, stopReason: 'error', errorMessage: String(error) },
          });
          stream.end();
        },
      );
      return stream;
    },
  });
}
