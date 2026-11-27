import {
  AgentApp,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk/unstable';
import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import path from 'node:path';
import installHistory, { historyCommand } from '../history.js';
import type { HistoryApi } from '../history.js';
import { OMP_TESTED_VERSION } from '../omp-version.js';

let history!: Parameters<HistoryApi['registerCommand']>[1]['handler'];
installHistory({
  registerCommand: (_name, command) => {
    history = command.handler;
  },
  appendEntry: () => {},
});
let release = () => {};
const options: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'first',
    options: [
      { name: 'First', value: 'first' },
      { name: 'Second', value: 'second' },
    ],
  },
];
const app = new AgentApp()
  .onRequest('initialize', () => {
    assert.equal(process.env.PI_EDIT_VARIANT, 'hashline');
    assert.equal(process.env.PI_STRICT_EDIT_MODE, '1');
    if (process.argv.includes('--unauthenticated'))
      throw RequestError.authRequired(undefined, 'Run omp and /login github-copilot.');
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'unit-fixture',
        version: process.argv.includes('--bad-version') ? 'wrong' : OMP_TESTED_VERSION,
      },
      agentCapabilities: { sessionCapabilities: { fork: {} } },
      authMethods: [],
    };
  })
  .onRequest('session/new', async ({ params, client }) => {
    assert.deepEqual(params.mcpServers, []);
    await client.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: historyCommand, description: 'Private history' },
          { name: 'context', description: 'Context' },
        ],
      },
    });
    process.stderr.write('Bearer fixture-token ghp_fixtureTOKEN12345\n');
    return { sessionId: 'native', configOptions: options };
  })
  .onRequest('session/load', async ({ params, client }) => {
    assert.deepEqual(params.mcpServers, []);
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: historyCommand, description: 'Private history' }],
      },
    });
    return { configOptions: options };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt[0]?.type === 'text' ? params.prompt[0].text : '';
    if (text === 'malformed') process.stdout.write('{invalid ACP frame}\n');
    if (text === 'oversized') process.stdout.write('x'.repeat(32 * 1024 * 1024 + 1) + '\n');
    if (text === 'exit') process.exit(19);
    if (text.startsWith(`/${historyCommand} `)) {
      await history(text.split(' ')[1]!, {
        isIdle: () => true,
        navigateTree: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: false }),
        sessionManager: {
          getSessionId: () => 'durable',
          getLeafId: () => null,
          getBranch: () => [],
          getSessionFile: () => path.join(process.env.VS_OMP_ARTIFACTS_ROOT!, 'fixture.jsonl'),
        },
      });
    } else if (text === 'wait') {
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'waiting' },
        },
      });
      await waiting;
      return { stopReason: 'cancelled' };
    }
    return { stopReason: 'end_turn' };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    options[0]!.currentValue = String(params.value);
    return { configOptions: options };
  })
  .onRequest('session/fork', () => ({
    sessionId: process.argv.includes('--same-fork') ? 'native' : 'forked',
  }))
  .onRequest('session/close', () => ({}))
  .onNotification('session/cancel', () => {
    release();
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
process.stdin.on('end', () => process.exit(0));
