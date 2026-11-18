import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OmpClient, promptBlocks } from '../acp.js';
import { HostTools, toolConfiguration } from '../host-tools.js';

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
      path.join(root, 'scripts', 'history-fixture.mjs'),
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
    async prompt() {
      await client.prompt(promptBlocks('BASH_FIXTURE'));
      const context = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
      const reply = context.messages.findLast(
        (message: { role: string }) => message.role === 'toolResult',
      );
      assert.ok(reply, 'The local provider must observe the actual tool result.');
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      assert.ok(
        JSON.stringify(reply.content).includes(command === 'pwd' ? cwd : 'NATIVE_TERMINAL_OUTPUT'),
      );
    },
  };
}
