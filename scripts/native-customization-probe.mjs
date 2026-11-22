import { writeFile } from 'node:fs/promises';

const markers = {
  root: 'V04_ROOT_SHADOWED',
  copilot: 'V04_COPILOT_SELECTED',
  always: 'V04_ALWAYS_RULE',
  conditional: 'V04_CONDITIONAL_BODY',
  description: 'V04_CONDITIONAL_DESCRIPTION',
};

async function discoveryMetadata(api, context, text) {
  const blocks = text ?? context.getSystemPrompt();
  const prompt =
    Array.isArray(blocks) && blocks.every((block) => typeof block === 'string')
      ? blocks.join('\n')
      : blocks;
  if (typeof prompt !== 'string') throw new Error('Unavailable prompt inspection.');
  const selected = JSON.parse(
    process.env.VS_OMP_NATIVE_CUSTOMIZATION_MARKERS || JSON.stringify(markers),
  );
  const entries = Object.entries(selected);
  if (
    entries.length > 32 ||
    entries.some(
      ([name, marker]) =>
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) ||
        typeof marker !== 'string' ||
        !/^V04_[A-Z0-9_]{1,64}$/.test(marker),
    )
  )
    throw new Error('Invalid fixture markers.');
  const commands = typeof api.getCommands === 'function' ? await api.getCommands() : undefined;
  return {
    status: 'passed',
    scope: 'offline-native-discovery',
    markers: Object.fromEntries(entries.map(([name, marker]) => [name, prompt.includes(marker)])),
    counts: Object.fromEntries(
      entries.map(([name, marker]) => [name, prompt.split(marker).length - 1]),
    ),
    order: entries
      .filter(([, marker]) => prompt.includes(marker))
      .sort(([, left], [, right]) => prompt.indexOf(left) - prompt.indexOf(right))
      .map(([name]) => name),
    commandsAvailable: Array.isArray(commands),
    commands: Object.fromEntries(
      ['v04-template', 'skill:v04-skill', 'v04-agent'].map((name) => [
        name,
        Array.isArray(commands) && commands.some((command) => command.name === name),
      ]),
    ),
  };
}

function probeRequestURL(input) {
  return new URL(typeof input === 'string' ? input : (input.url ?? input.href));
}

function probeTransport(origin) {
  const original = globalThis.fetch;
  let requests = 0;
  return async (input, init) => {
    if (!origin) throw new Error('Offline customization probe refuses network.');
    const url = probeRequestURL(input);
    const payload = JSON.parse(init?.body);
    if (
      url.origin !== origin ||
      url.pathname !== '/chat/completions' ||
      init?.method !== 'POST' ||
      payload.model !== 'probe' ||
      ++requests !== 1
    )
      throw new Error('Offline customization probe refuses network.');
    payload.max_completion_tokens = 1;
    return original(input, {
      ...init,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  };
}

export default function installCustomizationProbe(api) {
  if (process.env.VS_OMP_NATIVE_CUSTOMIZATION_PROBE !== '1') return;
  const origin = process.env.VS_OMP_NATIVE_CUSTOMIZATION_ORIGIN;
  if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
    throw new Error('Invalid disposable loopback origin.');
  globalThis.fetch = probeTransport(origin);
  api.registerProvider('vs-omp-customization', {
    api: 'openai-completions',
    baseUrl: origin ?? 'http://127.0.0.1:1',
    apiKey: 'fixture-only',
    models: [
      {
        id: 'probe',
        name: 'Offline customization probe',
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  api.on('before_agent_start', () => {
    if (!origin) throw new Error('Customization probe cannot start a turn.');
  });
  api.on('before_provider_request', () => {
    if (!origin) throw new Error('Customization probe cannot request inference.');
  });
  api.on('tool_call', () => ({
    block: true,
    reason: 'Offline customization probe refuses every tool execution.',
  }));
  api.registerCommand('vs-omp-customization-probe', {
    description: 'Inspect disposable discovery sentinels without generation.',
    handler: async (_args, context) => {
      let report;
      try {
        report = await discoveryMetadata(api, context);
      } catch {
        report = {
          status: 'failed',
          scope: 'offline-native-discovery',
          category: 'inspection-unavailable',
        };
      }
      await writeFile(process.env.VS_OMP_NATIVE_CUSTOMIZATION_REPORT, JSON.stringify(report), {
        mode: 0o600,
        flag: 'wx',
      });
    },
  });
}
