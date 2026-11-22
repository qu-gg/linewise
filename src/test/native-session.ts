import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OmpClient, promptBlocks } from '../acp.js';
import { HostTools, toolConfiguration } from '../host-tools.js';
import { TerminalManager } from '../terminal.js';

async function privateConfig(artifacts: string): Promise<string> {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const config = path.join(artifacts, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      ...toolConfiguration,
      memory: { backend: 'mnemopi' },
      mnemopi: {
        dbPath: path.join(artifacts, 'memory.sqlite'),
        noEmbeddings: true,
        llmMode: 'none',
      },
    }),
    { mode: 0o600 },
  );
  return config;
}

export async function nativeSession(
  tools: HostTools,
  cwd: string,
  scenario: string,
  abort: AbortController,
  command?: string,
  provider = 'history-fixture.mjs',
) {
  const root = process.env.VS_OMP_NATIVE_EXTENSION_ROOT;
  assert.ok(root, 'The fixture requires its development extension root.');
  const artifacts = path.join(cwd, '.native-private');
  const config = await privateConfig(artifacts);
  const marker = path.join(cwd, `native-${scenario}.txt`);
  const script = scenario.endsWith('-running')
    ? `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`
    : `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write('NATIVE_TERMINAL_OUTPUT');`;
  process.env.VS_OMP_FIXTURE_BASH =
    command ??
    `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}' # \u202eINVISIBLE VS_OMP_NATIVE_CASE=${scenario}`;
  process.env.VS_OMP_FIXTURE_CONTEXT = path.join(artifacts, 'provider-context.json');
  process.env.VS_OMP_FIXTURE_PID = path.join(artifacts, 'omp-pid.txt');
  const client = new OmpClient(
    {
      update: async () => {},
      read: (request) => tools.read(request),
      write: (request) => tools.write(request),
      permission: (request) => tools.permission(request),
      terminals: tools,
      closed: () => abort.abort(),
    },
    (message) => console.log(message),
  );
  await client.start({
    executable: process.env.OMP_EXECUTABLE || 'omp',
    cwd,
    artifacts,
    args: [
      '--config',
      config,
      '--no-extensions',
      '--no-title',
      '--no-lsp',
      '--extension',
      path.join(root, 'dist', 'omp-guard.js'),
      '--extension',
      path.join(root, 'scripts', provider),
      '--tools',
      'read,write,todo,retain,recall,memory_edit,edit,bash',
      '--approval-mode',
      'write',
      '--session-dir',
      path.join(artifacts, 'sessions'),
    ],
  });
  await client.setConfig('model', 'vs-omp-fixture/history');
  return {
    client,
    pid: Number(await readFile(process.env.VS_OMP_FIXTURE_PID, 'utf8')),
    async prompt(text = 'BASH_FIXTURE') {
      await client.prompt(promptBlocks(text));
      const context = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
      const reply = context.messages.findLast(
        (message: { role: string }) => message.role === 'toolResult',
      );
      assert.ok(reply, 'The local provider must observe the actual tool result.');
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      if (text === 'BASH_FIXTURE')
        assert.ok(
          JSON.stringify(reply.content).includes(
            command === 'pwd' ? cwd : 'NATIVE_TERMINAL_OUTPUT',
          ),
        );
    },
  };
}

type ManagedWaitScenario = 'complete' | 'stop' | 'disconnect' | 'exit';

function managedResults(text: string) {
  const state = JSON.parse(text);
  return state.messages
    .filter((message: { role: string }) => message.role === 'toolResult')
    .map((message: { isError?: boolean; content: { type: string; text?: string }[] }) => ({
      ...JSON.parse(message.content.find((block) => block.type === 'text')!.text!),
      isError: message.isError,
    }));
}

async function managedEvidence(
  text: string,
  scenario: ManagedWaitScenario,
  error?: unknown,
): Promise<void> {
  const root = path.join(
    process.env.VS_OMP_NATIVE_EXTENSION_ROOT!,
    'reports',
    'native-managed-wait',
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, 'run-'));
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({
      passed: error === undefined,
      scenario,
      error: error === undefined ? undefined : String(error),
      provider: 'local scripted fixture; no model inference',
      context: JSON.parse(text),
    }),
    { mode: 0o600 },
  );
  console.log(`Managed-wait native evidence: ${directory}`);
}

async function managedHold(
  execution: Promise<void>,
  held: Promise<void>,
  directory: string,
  interrupt?: () => Promise<void>,
) {
  const settled = execution.then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([
    held,
    execution.then(() => {
      throw new Error('Fixture ended before holding.');
    }),
  ]);
  const target = process.env.VS_OMP_FIXTURE_CONTEXT!;
  const before = await readFile(target, 'utf8');
  assert.equal(JSON.parse(before).fixtureReply[0].arguments.action, 'wait');
  assert.equal(managedResults(before).length, 2);
  await writeFile(path.join(directory, 'unrelated-host-work'), 'done');
  assert.equal(await readFile(target, 'utf8'), before);
  if (interrupt) {
    await interrupt();
    assert.ok((await settled) instanceof Error, 'Cancellation must reject the owning prompt.');
    assert.equal(await readFile(target, 'utf8'), before);
    return before;
  }
  await writeFile(path.join(directory, 'release'), 'finish');
  await execution;
  return readFile(target, 'utf8');
}

async function assertManagedResults(
  text: string,
  directory: string,
  stopped: boolean,
): Promise<void> {
  const results = managedResults(text);
  assert.equal(results.length, stopped ? 2 : 5);
  assert.equal(results[1].output.trim(), 'OTHER_SAFE_WORK');
  if (!stopped) {
    assert.equal(results[2].exitStatus.exitCode, 7);
    assert.equal(results[2].isError, true);
    assert.equal(results[2].output.trim(), 'NATIVE_TERMINAL_OUTPUT');
    assert.deepEqual(results[3], results[2]);
    assert.equal(results[4].isError, false);
  }
  const pid = Number(await readFile(path.join(directory, 'pid'), 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

function observeManagedWait(signal: AbortSignal) {
  const original = TerminalManager.prototype.waitForExit;
  let calls = 0;
  let entered!: () => void;
  const held = new Promise<void>((resolve, reject) => {
    entered = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  TerminalManager.prototype.waitForExit = function (request) {
    const pending = original.call(this, request);
    if (++calls === 2) entered();
    return pending;
  };
  return {
    held,
    calls: () => calls,
    restore: () => {
      TerminalManager.prototype.waitForExit = original;
    },
  };
}

async function interruptManagedWait(
  scenario: Exclude<ManagedWaitScenario, 'complete'>,
  abort: AbortController,
  session: Awaited<ReturnType<typeof nativeSession>>,
): Promise<void> {
  if (scenario === 'stop') {
    abort.abort(new Error('Stopped managed wait'));
    await session.client.cancel();
  } else if (scenario === 'disconnect') await session.client.stop();
  else process.kill(session.pid, 'SIGKILL');
}

export async function nativeManagedWait(
  cwd: string,
  files: ConstructorParameters<typeof HostTools>[0],
  journal: ConstructorParameters<typeof HostTools>[1],
  scenario: ManagedWaitScenario = 'complete',
): Promise<void> {
  const stopped = scenario !== 'complete';
  const directory = path.join(cwd, '.native-private', `managed-wait-${scenario}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = process.env.VS_OMP_FIXTURE_WAIT_DIR;
  process.env.VS_OMP_FIXTURE_WAIT_DIR = directory;
  const abort = new AbortController();
  const watchdog = AbortSignal.timeout(30000);
  const signal = AbortSignal.any([abort.signal, watchdog]);
  const approvals: string[] = [];
  const tools = new HostTools(
    files,
    journal,
    path.join(cwd, '.native-private', 'mutations'),
    async (prompt) => {
      approvals.push(prompt.details);
      return true;
    },
  );
  const session = await nativeSession(tools, cwd, 'managed-wait', abort);
  const observation = observeManagedWait(signal);
  try {
    const execution = tools.run(
      {
        sessionId: session.client.sessionId!,
        owner: 'managed-wait',
        cwd,
        signal,
        valid: () => true,
      },
      () => session.prompt('MANAGED_WAIT_FIXTURE'),
    );
    const text = await managedHold(
      execution,
      observation.held,
      directory,
      scenario === 'complete' ? undefined : () => interruptManagedWait(scenario, abort, session),
    );
    await assertManagedResults(text, directory, stopped);
    assert.equal(observation.calls(), stopped ? 2 : 3);
    assert.equal(approvals.length, 2);
    assert.equal(tools.cleanupFailed, false);
    await managedEvidence(text, scenario);
    console.log(
      `PASS: installed OMP managed wait ${scenario} without provider continuation while held.`,
    );
  } catch (error) {
    const text = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8').catch(() => '{}');
    await managedEvidence(text, scenario, error);
    throw error;
  } finally {
    abort.abort();
    observation.restore();
    if (previous === undefined) delete process.env.VS_OMP_FIXTURE_WAIT_DIR;
    else process.env.VS_OMP_FIXTURE_WAIT_DIR = previous;
    try {
      await session.client.stop();
    } finally {
      await tools.finish();
    }
  }
}
