import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const nativeOnly = { skip: process.env.VS_OMP_NATIVE_CUSTOMIZATION_TESTS !== '1' };

async function fixture(context, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-customization-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  const agent = path.join(home, 'agent');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(agent, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, content, { mode: 0o600, flag: 'wx' });
  }
  return { directory, root, home, agent, runs: 0 };
}

async function nativeProbe(owned, options = {}) {
  if (options.activation && !options.origin) return activationProbe(owned, options);
  const { instructionArguments, workspaceInstructions, withInstructionSnapshot } =
    await import('../dist/workspace-instructions.js');
  if (options.workspaceSnapshot) {
    const instructions = await workspaceInstructions(owned.root, (target) =>
      readFile(target, 'utf8'),
    );
    return withInstructionSnapshot(owned.directory, instructions, (snapshot) =>
      nativeProbe(owned, { ...options, workspaceSnapshot: false, snapshot }),
    );
  }
  const { directory } = owned;
  const reportFile = path.join(directory, `report-${++owned.runs}.json`);
  const extra = [];
  if (options.settings) {
    const config = path.join(directory, `config-${owned.runs}.json`);
    await writeFile(config, JSON.stringify(options.settings), { mode: 0o600, flag: 'wx' });
    extra.push('--config', config);
  }
  if (options.snapshot) extra.push(...instructionArguments(options.snapshot));
  if (options.acp) {
    const sessionFile = await acpProbe(owned, extra, reportFile, options);
    return options.activation
      ? { sessionFile }
      : { ...JSON.parse(await readFile(reportFile, 'utf8')), sessionFile };
  }
  return printProbe(owned, options, extra, reportFile);
}

async function activationProbe(owned, options) {
  let requests = 0;
  let report;
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(++requests, 1);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/chat/completions');
        assert.equal(payload.model, 'probe');
        assert.equal(payload.max_completion_tokens, 1);
        const text = JSON.stringify(payload.messages);
        report = {
          status: 'passed',
          scope: 'activation-loopback-transport',
          requests,
          markers: Object.fromEntries(
            Object.entries(options.markers).map(([name, marker]) => [name, text.includes(marker)]),
          ),
        };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'LOCAL_SKILL_ONLY' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
        );
      } catch {
        report = { status: 'failed', scope: 'activation-loopback-transport' };
        response.writeHead(400);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await nativeProbe(owned, {
      ...options,
      origin: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(requests, 1, 'Native skill activation must dispatch exactly one local request.');
    assert.equal(report?.status, 'passed');
    return { ...result, ...report };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function printProbe(owned, options, extra, reportFile) {
  const { directory, root, home, agent } = owned;
  const result = spawnSync(
    process.env.OMP_EXECUTABLE || 'omp',
    [
      '--print',
      '--no-session',
      ...(options.tools ? ['--tools', options.tools] : ['--tools', '']),
      '--no-extensions',
      '--no-title',
      '--no-lsp',
      '--offline',
      '--max-time',
      '20',
      '--model',
      'vs-omp-customization/probe',
      '--extension',
      path.resolve('scripts/native-customization-probe.mjs'),
      ...extra,
      '/vs-omp-customization-probe',
    ],
    {
      cwd: options.cwd ? path.join(directory, options.cwd) : root,
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 1_048_576,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        XDG_CONFIG_HOME: home,
        VS_OMP_NATIVE_CUSTOMIZATION_PROBE: '1',
        VS_OMP_NATIVE_CUSTOMIZATION_REPORT: reportFile,
        ...(options.markers
          ? { VS_OMP_NATIVE_CUSTOMIZATION_MARKERS: JSON.stringify(options.markers) }
          : {}),
      },
    },
  );
  const diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failure = {
    generationBlocked: diagnostic.includes('Customization probe cannot'),
    networkBlocked: diagnostic.includes('Offline customization probe refuses network'),
    modelUnavailable: /unknown model|not found|no models/i.test(diagnostic),
    extensionFailure: /failed to load|extension error|registerProvider|streamSimple/i.test(
      diagnostic,
    ),
    optionFailure: /unknown option|unrecognized option/i.test(diagnostic),
    authentication: /API key|credential|authentication/i.test(diagnostic),
  };
  assert.equal(
    result.status,
    0,
    `Offline discovery failed: ${JSON.stringify(failure)}; raw diagnostics are private.`,
  );
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(report.status, 'passed', 'Native prompt inspection must succeed.');
  assert.equal((await stat(reportFile)).mode & 0o777, 0o600);
  return report;
}

async function acpProbe(owned, extra, reportFile, options) {
  const { OmpClient, promptBlocks } = await import('../dist/acp.js');
  const refused = async () => {
    throw new Error('Offline discovery refuses host tools.');
  };
  let preAgentRefused = false;
  let completedReply = false;
  const observe = (message) => {
    completedReply ||= message.includes('LOCAL_SKILL_ONLY');
    preAgentRefused ||= /Customization probe cannot (?:start a turn|request inference)\./.test(
      message,
    );
  };
  const client = new OmpClient(
    {
      update: async (notification) => observe(JSON.stringify(notification)),
      read: refused,
      write: refused,
      permission: refused,
    },
    observe,
  );
  const previous = process.env;
  try {
    process.env = {
      PATH: previous.PATH,
      HOME: owned.home,
      PI_CODING_AGENT_DIR: owned.agent,
      VS_OMP_NATIVE_CUSTOMIZATION_PROBE: '1',
      VS_OMP_NATIVE_CUSTOMIZATION_REPORT: reportFile,
      VS_OMP_NATIVE_CUSTOMIZATION_MARKERS: JSON.stringify(options.markers),
      ...(options.origin ? { VS_OMP_NATIVE_CUSTOMIZATION_ORIGIN: options.origin } : {}),
    };
    await client.start({
      executable: previous.OMP_EXECUTABLE || 'omp',
      cwd: owned.root,
      artifacts: owned.directory,
      sessionFile: options.sessionFile,
      args: [
        ...(options.tools ? ['--tools', options.tools] : ['--tools', '']),
        '--no-extensions',
        '--no-title',
        '--no-lsp',
        '--offline',
        '--model',
        'vs-omp-customization/probe',
        '--extension',
        path.resolve('scripts/native-customization-probe.mjs'),
        '--extension',
        path.resolve('dist/omp-guard.js'),
        '--session-dir',
        owned.directory,
        ...extra,
      ],
    });
    process.env = previous;
    let blocked = false;
    try {
      await client.prompt(promptBlocks(options.command ?? '/vs-omp-customization-probe'));
    } catch {
      blocked = true;
    }
    assert.equal(blocked || preAgentRefused, false, 'The owned ACP command must complete.');
    if (options.activation) assert.equal(completedReply, true);
    return (await client.history()).fileName;
  } finally {
    process.env = previous;
    await client.stop();
  }
}

test(
  'installed offline discovery separates Copilot precedence and conditional rules',
  nativeOnly,
  async (context) => {
    const owned = await fixture(context, {
      'project/AGENTS.md': 'V04_ROOT_SHADOWED\n',
      'project/.github/copilot-instructions.md': 'V04_COPILOT_SELECTED\n',
      'project/.github/instructions/always.instructions.md':
        '---\napplyTo: "**"\n---\nV04_ALWAYS_RULE\n',
      'project/.github/instructions/conditional.instructions.md':
        '---\napplyTo: "src/**/*.ts"\ndescription: V04_CONDITIONAL_DESCRIPTION\n---\nV04_CONDITIONAL_BODY\n',
    });
    const report = await nativeProbe(owned);
    assert.deepEqual(report.markers, {
      root: false,
      copilot: true,
      always: true,
      conditional: false,
      description: true,
    });
  },
);

test('installed customization: reload freshness', nativeOnly, async (context) => {
  const owned = await fixture(context, { 'project/AGENTS.md': 'V04_OLD\n' });
  const options = {
    acp: true,
    workspaceSnapshot: true,
    markers: { old: 'V04_OLD', fresh: 'V04_FRESH' },
  };
  const first = await nativeProbe(owned, options);
  await writeFile(path.join(owned.root, 'AGENTS.md'), 'V04_FRESH\n');
  const reloaded = await nativeProbe(owned, options);
  assert.deepEqual(first.markers, { old: true, fresh: false });
  assert.deepEqual(reloaded.markers, { old: false, fresh: true });
});

test('installed customization: resume freshness', nativeOnly, async (context) => {
  const owned = await fixture(context, { 'project/AGENTS.md': 'V04_OLD\n' });
  const options = {
    acp: true,
    workspaceSnapshot: true,
    markers: { old: 'V04_OLD', fresh: 'V04_FRESH' },
  };
  const first = await nativeProbe(owned, options);
  assert.ok(first.sessionFile);
  await writeFile(path.join(owned.root, 'AGENTS.md'), 'V04_FRESH\n');
  const resumed = await nativeProbe(owned, { ...options, sessionFile: first.sessionFile });
  assert.equal(resumed.sessionFile, first.sessionFile);
  assert.deepEqual(first.markers, { old: true, fresh: false });
  assert.deepEqual(resumed.markers, { old: false, fresh: true });
});

test('installed customization: explicit skill activation', nativeOnly, async (context) => {
  const owned = await fixture(context, {
    'project/AGENTS.md': 'V04_ROOT\n',
    'project/.omp/skills/v04-skill/SKILL.md':
      '---\nname: v04-skill\ndescription: V04_SKILL_CATALOG\n---\nV04_SKILL_BODY\n',
  });
  const markers = { catalog: 'V04_SKILL_CATALOG', body: 'V04_SKILL_BODY' };
  const discovery = await nativeProbe(owned, {
    acp: true,
    tools: 'read',
    markers,
  });
  assert.deepEqual(discovery.markers, { catalog: true, body: false });
  assert.equal(discovery.commandsAvailable, true);
  assert.equal(discovery.commands['skill:v04-skill'], true);
  const activated = await nativeProbe(owned, {
    acp: true,
    tools: 'read',
    activation: true,
    command: '/skill:v04-skill',
    markers,
  });
  assert.equal(activated.scope, 'activation-loopback-transport');
  assert.equal(activated.requests, 1);
  assert.equal(activated.markers.body, true);
  const { scope, requests, markers: observed } = activated;
  context.diagnostic(JSON.stringify({ scope, requests, markers: observed }));
});

const discoveryCases = [
  {
    name: 'root discovery',
    files: { 'project/AGENTS.md': 'V04_ROOT\n' },
    markers: { root: 'V04_ROOT' },
    expected: { root: true },
  },
  {
    name: 'nested scope',
    cwd: 'project/nested',
    files: {
      'project/AGENTS.md': 'V04_ROOT\n',
      'project/.github/copilot-instructions.md': 'V04_PARENT_COPILOT\n',
      'project/nested/AGENTS.md': 'V04_NESTED\n',
    },
    markers: { root: 'V04_ROOT', nested: 'V04_NESTED', copilot: 'V04_PARENT_COPILOT' },
    expected: { root: true, nested: true, copilot: false },
    order: ['root', 'nested'],
  },
  {
    name: 'fixture-user scope',
    files: { 'project/AGENTS.md': 'V04_ROOT\n', 'home/agent/AGENTS.md': 'V04_USER\n' },
    markers: { root: 'V04_ROOT', user: 'V04_USER' },
    expected: { root: true, user: true },
    order: ['user', 'root'],
  },
  {
    name: 'precedence conflict',
    files: {
      'project/AGENTS.md': 'V04_ROOT\n',
      'project/.github/copilot-instructions.md': 'V04_COPILOT\n',
      'project/.omp/AGENTS.md': 'V04_NATIVE\n',
    },
    markers: { root: 'V04_ROOT', copilot: 'V04_COPILOT', native: 'V04_NATIVE' },
    expected: { root: false, copilot: false, native: true },
  },
  {
    name: 'duplicate names',
    cwd: 'project/nested',
    tools: 'read',
    files: {
      'project/AGENTS.md': 'V04_DUPLICATE\n',
      'project/nested/AGENTS.md': 'V04_DUPLICATE\n',
      'project/.omp/skills/v04-skill/SKILL.md':
        '---\nname: v04-skill\ndescription: V04_PROJECT_SKILL\n---\nV04_PROJECT_BODY\n',
      'home/agent/skills/v04-skill/SKILL.md':
        '---\nname: v04-skill\ndescription: V04_USER_SKILL\n---\nV04_USER_BODY\n',
    },
    markers: {
      duplicate: 'V04_DUPLICATE',
      project: 'V04_PROJECT_SKILL',
      user: 'V04_USER_SKILL',
      projectBody: 'V04_PROJECT_BODY',
      userBody: 'V04_USER_BODY',
    },
    expected: { duplicate: true, project: true, user: true, projectBody: false, userBody: false },
    count: { duplicate: 1 },
  },
  {
    name: 'malformed frontmatter',
    files: {
      'project/.omp/skills/malformed/SKILL.md':
        '---\nname: malformed\ndescription: [invalid\n---\nV04_MALFORMED_BODY\n',
    },
    markers: { malformed: 'V04_MALFORMED_BODY' },
    expected: { malformed: false },
  },
  {
    name: 'disabled source',
    settings: { disabledProviders: ['github'] },
    files: {
      'project/AGENTS.md': 'V04_ROOT\n',
      'project/.github/copilot-instructions.md': 'V04_COPILOT\n',
    },
    markers: { root: 'V04_ROOT', copilot: 'V04_COPILOT' },
    expected: { root: true, copilot: false },
  },
  {
    name: 'unsupported name',
    files: {
      'project/TEAM.md': 'V04_UNSUPPORTED\n',
      'project/unlisted.instructions.md': '---\napplyTo: "**"\n---\nV04_UNLISTED\n',
      'project/.github/prompts/v04-template.prompt.md':
        '---\ndescription: Fixture template\n---\nV04_PROMPT_BODY\n',
      'project/.github/agents/v04-agent.agent.md':
        '---\nname: v04-agent\ndescription: Fixture agent\n---\nV04_AGENT_BODY\n',
    },
    markers: {
      unsupported: 'V04_UNSUPPORTED',
      unlisted: 'V04_UNLISTED',
      prompt: 'V04_PROMPT_BODY',
      agent: 'V04_AGENT_BODY',
    },
    expected: { unsupported: false, unlisted: false, prompt: false, agent: false },
  },
  {
    name: 'root isolation',
    cwd: 'other-project',
    files: {
      'project/AGENTS.md': 'V04_OTHER_ROOT\n',
      'other-project/AGENTS.md': 'V04_SELECTED_ROOT\n',
    },
    markers: { other: 'V04_OTHER_ROOT', selected: 'V04_SELECTED_ROOT' },
    expected: { other: false, selected: true },
  },
];

for (const item of discoveryCases)
  test(`installed customization: ${item.name}`, nativeOnly, async (context) => {
    const owned = await fixture(context, item.files);
    const report = await nativeProbe(owned, item);
    assert.deepEqual(report.markers, item.expected);
    if (item.name === 'unsupported name')
      assert.ok(Object.values(report.commands).every((available) => available === false));
    if (item.order) assert.deepEqual(report.order, item.order);
    for (const [name, count] of Object.entries(item.count ?? {}))
      assert.equal(report.counts[name], count);
    for (const [name, content] of Object.entries(item.files)) {
      assert.ok((await readFile(path.join(owned.directory, name), 'utf8')) === content);
    }
  });

test(
  'native instruction imports do not bypass outside and private read authority',
  nativeOnly,
  async (context) => {
    const owned = await fixture(context, {
      'home/outside.md': 'V04_OUTSIDE_IMPORT\n',
      'home/agent/control/private.md': 'V04_PRIVATE_IMPORT\n',
      'project/.omp/RULES.md': 'V04_NATIVE_RULE\n',
      'home/agent/skills/v04-skill/SKILL.md':
        '---\nname: v04-skill\ndescription: V04_USER_SKILL\n---\nV04_USER_BODY\n',
      'project/.github/instructions/always.instructions.md':
        '---\napplyTo: "**"\n---\nV04_UNMEDIATED_RULE\n',
    });
    await writeFile(
      path.join(owned.root, 'AGENTS.md'),
      `V04_ROOT\n\n@${path.join(owned.home, 'outside.md')}\n\n@${path.join(owned.agent, 'control/private.md')}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const options = {
      workspaceSnapshot: true,
      markers: {
        root: 'V04_ROOT',
        outside: 'V04_OUTSIDE_IMPORT',
        private: 'V04_PRIVATE_IMPORT',
        nativeRule: 'V04_NATIVE_RULE',
        unmediated: 'V04_UNMEDIATED_RULE',
        skill: 'V04_USER_SKILL',
      },
    };
    const expected = {
      root: true,
      outside: false,
      private: false,
      nativeRule: false,
      unmediated: false,
      skill: false,
    };
    for (const acp of [false, true]) {
      const report = await nativeProbe(owned, { ...options, acp });
      assert.deepEqual(report.markers, expected);
    }
  },
);
