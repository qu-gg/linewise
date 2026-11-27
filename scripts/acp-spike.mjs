import { ClientApp, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../dist/terminal.js';
import { nativeMutations } from './native-mutations.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vs-omp-acp-'));
const historyDirectory = join(directory, 'control');
const historyEnabled = process.env.OMP_SPIKE_HISTORY === '1';
const terminalsEnabled = process.env.OMP_SPIKE_TERMINALS === '1';
const toolsEnabled = process.env.OMP_SPIKE_TOOLS === '1';
const mutations = toolsEnabled ? nativeMutations(directory) : undefined;
const terminalMarker = join(directory, 'terminal-marker.txt');
let terminalCreates = 0;
const permissionKinds = [];
let terminalManager;
let allowPermission = true;
const terminalMethods = [];
const fileCalls = [];
if (historyEnabled) await mkdir(historyDirectory, { mode: 0o700 });
const configPath = join(directory, 'config.json');
await writeFile(
  configPath,
  JSON.stringify({
    memory: { backend: 'mnemopi' },
    mnemopi: {
      dbPath: join(directory, 'memory', 'mnemopi.db'),
      noEmbeddings: true,
      llmMode: 'none',
      scoping: 'per-project',
    },
    tools: { xdev: false, approvalMode: toolsEnabled ? 'write' : 'always-ask' },
  }),
  { mode: 0o600 },
);
const child = spawn(
  process.env.OMP_EXECUTABLE || 'omp',
  [
    'acp',
    '--config',
    configPath,
    ...(toolsEnabled ? [] : terminalsEnabled ? ['--tools', 'bash'] : ['--tools', '']),
    '--no-extensions',
    '--no-title',
    ...(toolsEnabled
      ? ['--extension', fileURLToPath(new URL('./native-edit-probe.mjs', import.meta.url))]
      : []),
    ...(historyEnabled
      ? ['--extension', fileURLToPath(new URL('../dist/history.js', import.meta.url))]
      : []),
    ...(historyEnabled || terminalsEnabled || toolsEnabled
      ? ['--extension', fileURLToPath(new URL('./history-fixture.mjs', import.meta.url))]
      : []),
    '--session-dir',
    join(directory, 'sessions'),
    '--approval-mode',
    toolsEnabled ? 'write' : 'always-ask',
  ],
  {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(toolsEnabled ? { VS_OMP_ARTIFACTS_ROOT: join(directory, 'private') } : {}),
      ...(toolsEnabled
        ? {
            VS_OMP_FIXTURE_CONTEXT: join(directory, 'provider-context.json'),
            VS_OMP_FIXTURE_NATIVE: '1',
          }
        : {}),
      ...(historyEnabled ? { VS_OMP_HISTORY_DIR: historyDirectory } : {}),
      ...(terminalsEnabled
        ? {
            VS_OMP_FIXTURE_CONTEXT: join(directory, 'provider-context.json'),
            VS_OMP_FIXTURE_BASH:
              'printf SHELL_EXECUTED > terminal-marker.txt; printf ACP_TERMINAL_FIXTURE',
          }
        : {}),
    },
  },
);
const exited = once(child, 'exit');
let stderrBytes = 0;
let responseText = '';
let availableCommands = [];
let commandsReady;
const commandsReceived = new Promise((resolve) => {
  commandsReady = resolve;
});
child.stderr.on('data', (chunk) => {
  stderrBytes += chunk.length;
  if (toolsEnabled) process.stderr.write(chunk);
});
const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);

try {
  const transport = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientApp()
    .onNotification('session/update', async ({ params }) => {
      if (params.update.sessionUpdate === 'available_commands_update') {
        availableCommands = params.update.availableCommands.map((command) => command.name);
        commandsReady();
      }
      if (
        params.update.sessionUpdate === 'agent_message_chunk' &&
        params.update.content.type === 'text'
      ) {
        responseText += params.update.content.text;
      }
    })
    .onRequest('session/request_permission', async ({ params }) => {
      if (mutations) return mutations.permission(params);
      if (!terminalsEnabled && !toolsEnabled) return { outcome: { outcome: 'cancelled' } };
      permissionKinds.push(params.options.map((option) => option.kind));
      const selected =
        allowPermission && params.options.find((option) => option.kind === 'allow_once');
      if (toolsEnabled)
        console.log(
          JSON.stringify({
            stage: 'tools/permission',
            toolCall: params.toolCall,
            options: params.options,
            selected: selected && selected.optionId,
          }),
        );
      return {
        outcome: selected
          ? { outcome: 'selected', optionId: selected.optionId }
          : { outcome: 'cancelled' },
      };
    })
    .onRequest('fs/read_text_file', async ({ params }) => {
      assert.equal(params.path, join(directory, 'probe.txt'));
      fileCalls.push('read');
      return { content: await readFile(params.path, 'utf8') };
    })
    .onRequest('fs/write_text_file', async ({ params }) => {
      assert.ok([join(directory, 'probe.txt'), join(directory, 'moved.txt')].includes(params.path));
      fileCalls.push('write');
      await writeFile(params.path, params.content);
      return {};
    })
    .onRequest('terminal/create', async ({ params }) => {
      terminalCreates++;
      terminalMethods.push('create');
      assert.ok(terminalManager, 'No active fixture terminal scope.');
      return terminalManager.create(params);
    })
    .onRequest('terminal/output', ({ params }) => {
      terminalMethods.push('output');
      return terminalManager.output(params);
    })
    .onRequest('terminal/wait_for_exit', ({ params }) => {
      terminalMethods.push('wait');
      return terminalManager.waitForExit(params);
    })
    .onRequest('terminal/kill', ({ params }) => {
      terminalMethods.push('kill');
      return terminalManager.kill(params);
    })
    .onRequest('terminal/release', ({ params }) => {
      terminalMethods.push('release');
      return terminalManager.release(params);
    })
    .onRequest('*', async () => {
      throw new Error('Client operations disabled for handshake.');
    })
    .connect(transport);
  const initialized = await connection.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vs-omp-feasibility', version: '0.0.1' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      ...(terminalsEnabled ? { terminal: true } : {}),
    },
  });
  console.log(
    JSON.stringify(
      {
        stage: 'initialize',
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
        authMethods: initialized.authMethods?.map((method) => ({
          id: method.id,
          name: method.name,
        })),
      },
      null,
      2,
    ),
  );
  const session = await connection.agent.request('session/new', { cwd: directory, mcpServers: [] });
  const modelConfig = session.configOptions?.find((option) => option.id === 'model');
  const availableModels =
    modelConfig?.type === 'select'
      ? modelConfig.options.flatMap((option) => ('group' in option ? option.options : [option]))
      : [];
  const copilotModels = availableModels.filter((option) =>
    option.value.startsWith('github-copilot/'),
  );
  console.log(
    JSON.stringify(
      {
        stage: 'session/new',
        sessionCreated: Boolean(session.sessionId),
        currentModelId: modelConfig?.currentValue,
        copilotModels: copilotModels.map((option) => option.value),
        memory: 'per-project Mnemopi, full-text-only, no extraction model',
      },
      null,
      2,
    ),
  );
  if (toolsEnabled) {
    assert.equal(process.env.OMP_SPIKE_PROMPT, '0', 'Tool inspection must not use paid inference.');
    await commandsReceived;
    assert.ok(availableCommands.includes('vs-omp-native-probe'));
    await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/vs-omp-native-probe' }],
    });
    const nativeApi = JSON.parse(await readFile(join(directory, 'native-api.json'), 'utf8'));
    console.log(JSON.stringify({ stage: 'tools/native-api', api: nativeApi }));
    assert.ok(!nativeApi.error, nativeApi.error);
    await mutations.run(connection, session);
  }
  if (historyEnabled) {
    const { historyCommand, historyResponseSchema } = await import('../dist/history.js');
    if (!initialized.agentCapabilities?.sessionCapabilities?.fork)
      throw new Error('OMP did not advertise ACP session forking.');
    await Promise.race([
      commandsReceived,
      exited.then(() => {
        throw new Error('OMP exited before advertising commands.');
      }),
    ]);
    if (!availableCommands.includes(historyCommand))
      throw new Error('OMP did not load the history bridge.');
    await connection.agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: 'vs-omp-fixture/history',
    });
    const history = async (operation = { action: 'inspect' }) => {
      const id = randomUUID();
      await writeFile(
        join(historyDirectory, `request-${id}.json`),
        JSON.stringify({ ...operation, id }),
        { mode: 0o600 },
      );
      await connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `/${historyCommand} ${id}` }],
      });
      const response = historyResponseSchema.parse(
        JSON.parse(await readFile(join(historyDirectory, `response-${id}.json`), 'utf8')),
      );
      assert.equal(response.id, id);
      if (!response.ok) throw new Error(response.error);
      return response.snapshot;
    };
    const before = await history();
    assert.deepEqual(await history(), before);
    assert.equal(responseText, '');
    console.log(
      JSON.stringify({
        stage: 'history/inspect',
        durableIdentity: Boolean(before.sessionId),
        entries: before.entries.length,
        historyUnchanged: true,
        noChatOutput: true,
      }),
    );
    const historyCommands = availableCommands.filter((command) =>
      ['branch', 'rewind', 'tree', 'fork'].includes(command),
    );
    const forked = await connection.agent.request('session/fork', {
      sessionId: session.sessionId,
      cwd: directory,
      mcpServers: [],
    });
    if (!forked.sessionId || forked.sessionId === session.sessionId)
      throw new Error('Fork did not create an independent session identity.');
    await connection.agent.request('session/close', { sessionId: forked.sessionId });
    const restored = await connection.agent.request('session/load', {
      sessionId: session.sessionId,
      cwd: directory,
      mcpServers: [],
    });
    if (!restored.configOptions?.some((option) => option.id === 'model'))
      throw new Error('The original session is no longer usable after forking.');
    console.log(
      JSON.stringify({
        stage: 'session/fork',
        independentIdentity: true,
        originalStillUsable: true,
        historyCommands,
        scope:
          'Whole empty-session fork with the source kept open; historical entry selection and populated-session restoration are not tested.',
      }),
    );
    const prompt = async (text) =>
      connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text }],
      });
    await writeFile(join(directory, 'protected.txt'), 'USER_WORK\n');
    await prompt('PAST_SENTINEL');
    await prompt('FUTURE_SENTINEL');
    const populated = await history();
    const target = populated.entries.filter((entry) => entry.role === 'user')[1];
    assert.ok(target);
    await history({
      action: 'navigate',
      sessionId: populated.sessionId,
      leafId: populated.leafId,
      entryId: target.id,
    });
    await prompt('REPLACEMENT_SENTINEL');
    const providerContext = JSON.stringify(
      JSON.parse(await readFile(join(historyDirectory, 'provider-context.json'), 'utf8')).messages,
    );
    assert.ok(providerContext.includes('PAST_SENTINEL'));
    assert.ok(providerContext.includes('REPLACEMENT_SENTINEL'));
    assert.ok(!providerContext.includes('FUTURE_SENTINEL'));
    assert.equal(await readFile(join(directory, 'protected.txt'), 'utf8'), 'USER_WORK\n');
    console.log(
      JSON.stringify({
        stage: 'history/navigate',
        nativeContextVerified: true,
        futureExcluded: true,
        workspaceUnchanged: true,
        provider: 'local fixture; no paid requests',
      }),
    );
  }
  if (terminalsEnabled) {
    assert.equal(
      process.env.OMP_SPIKE_PROMPT,
      '0',
      'The terminal probe must not enable paid inference.',
    );
    await connection.agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: 'vs-omp-fixture/history',
    });
    for (const scenario of ['reject', 'approve', 'permission-reject', 'cancel']) {
      const abort = new AbortController();
      let approvalReady;
      const pendingApproval = new Promise((resolve) => {
        approvalReady = resolve;
      });
      let lateApproval;
      allowPermission = scenario !== 'permission-reject';
      const createsBefore = terminalCreates;
      terminalManager = new TerminalManager({
        sessionId: session.sessionId,
        cwd: directory,
        signal: abort.signal,
        approve: async (command) => {
          assert.equal(command.cwd, directory);
          if (scenario !== 'cancel') return scenario === 'approve';
          approvalReady();
          return new Promise((resolve) => {
            lateApproval = resolve;
          });
        },
      });
      const prompt = connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `BASH_FIXTURE ${scenario}` }],
      });
      if (scenario === 'cancel') {
        await Promise.race([
          pendingApproval,
          prompt.then(() => {
            throw new Error('Prompt finished before approval.');
          }),
        ]);
        abort.abort();
        await connection.agent.notify('session/cancel', { sessionId: session.sessionId });
      }
      await prompt;
      lateApproval?.(true);
      await terminalManager.dispose();
      const context = JSON.parse(await readFile(join(directory, 'provider-context.json'), 'utf8'));
      const result = context.messages.findLast((message) => message.role === 'toolResult');
      assert.equal(
        result?.toolName,
        'bash',
        'The probe must actually invoke the installed bash tool.',
      );
      const marker = await readFile(terminalMarker, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      assert.equal(marker, scenario === 'approve' ? 'SHELL_EXECUTED' : null);
      assert.equal(terminalCreates - createsBefore, scenario === 'permission-reject' ? 0 : 1);
      if (scenario === 'approve')
        assert.ok(JSON.stringify(result.content).includes('ACP_TERMINAL_FIXTURE'));
      console.log(
        JSON.stringify({
          stage: `terminal/${scenario}`,
          passed: true,
          terminalCreates: terminalCreates - createsBefore,
          marker,
          provider: 'local fixture; no paid requests',
        }),
      );
      await rm(terminalMarker, { force: true });
    }
    console.log(
      JSON.stringify({
        stage: 'terminal/routing',
        terminalMethods,
        permissionKinds,
        terminalCapabilityAdvertised: true,
        productionShellsEnabled: false,
      }),
    );
  }
  if (process.env.OMP_SPIKE_CONTEXT === '1') {
    await Promise.race([
      commandsReceived,
      exited.then(() => {
        throw new Error('OMP exited before advertising commands.');
      }),
    ]);
    for (const command of ['context', 'compact']) {
      if (!availableCommands.includes(command))
        throw new Error(`OMP did not advertise /${command}.`);
      responseText = '';
      const result = await connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `/${command}` }],
      });
      console.log(
        JSON.stringify({
          stage: `session/${command}`,
          advertised: true,
          stopReason: result.stopReason,
          text: responseText.slice(0, 3000),
        }),
      );
      if (!responseText.trim()) throw new Error(`/${command} returned no result.`);
    }
    responseText = '';
  }
  if (process.env.OMP_SPIKE_PROMPT === '1') {
    const model =
      copilotModels.find((option) => /\/(gpt-4\.1|gpt-5-mini)$/.test(option.value)) ??
      copilotModels[0];
    if (!model)
      throw new Error(
        'No authenticated GitHub Copilot models are available. Run omp and /login first.',
      );
    await connection.agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: model.value,
    });
    const result = await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly OMP_ACP_OK. Do not call tools.' }],
    });
    console.log(
      JSON.stringify({
        stage: 'model-response',
        model: model.value,
        stopReason: result.stopReason,
        text: responseText,
      }),
    );
    if (responseText.trim() !== 'OMP_ACP_OK')
      throw new Error('The model did not return the expected handshake response.');
  }
  await connection.agent.request('session/close', { sessionId: session.sessionId });
} finally {
  clearTimeout(deadline);
  await terminalManager?.dispose();
  child.kill('SIGTERM');
  const forceExit = setTimeout(() => child.kill('SIGKILL'), 1_500);
  await exited;
  clearTimeout(forceExit);
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ stage: 'shutdown', stderrBytes }));
}
