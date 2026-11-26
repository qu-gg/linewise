import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { ClientHandlers, OmpClient as ActualClient } from '../acp.js';
import type { HistoryOperation, HistorySnapshot } from '../history.js';
import { promisify } from 'node:util';
export { promptBlocks, safeError, selectOptions } from '../acp.js';

export const transport = {
  client: undefined as OmpClient | undefined,
  started: undefined as Parameters<ActualClient['start']>[0] | undefined,
  onPrompt: async (_blocks: ContentBlock[]) => {},
  onCancel: () => {},
  backend: 'local',
  version: '18.21.0',
  configError: undefined as Error | undefined,
  nextSessionId: undefined as string | undefined,
  configOptions: undefined as SessionConfigOption[] | undefined,
};

export const execFile = Object.assign(
  () => {
    throw new Error('Tests must not launch external processes.');
  },
  {
    [promisify.custom]: async (_executable: string, args: string[]) => {
      if (transport.configError) throw transport.configError;
      if (args[0] === '--version') return { stdout: transport.version, stderr: '' };
      return { stdout: JSON.stringify({ value: transport.backend }), stderr: '' };
    },
  },
);

export class OmpClient {
  connected = false;
  historyAvailable = false;
  sessionId = transport.nextSessionId ?? 'native-session';
  configOptions: SessionConfigOption[] = transport.configOptions ?? [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'github-copilot/gpt-4.1',
      options: [{ name: 'GPT-4.1', value: 'github-copilot/gpt-4.1' }],
    },
  ];
  constructor(
    readonly handlers: ClientHandlers,
    readonly log: (message: string) => void = () => {},
  ) {
    transport.client = this;
  }
  async start(options: Parameters<ActualClient['start']>[0]) {
    transport.started = options;
    this.connected = true;
  }
  async stop() {
    this.connected = false;
  }
  async cancel() {
    transport.onCancel();
  }
  async prompt(blocks: ContentBlock[]) {
    await transport.onPrompt(blocks);
    return { stopReason: 'end_turn' };
  }
  async setConfig(id: string, value: string) {
    this.configOptions.find((option) => option.id === id)!.currentValue = value;
  }
  async history(
    _operation: HistoryOperation = { action: 'inspect' },
    _sessionId = this.sessionId,
  ): Promise<HistorySnapshot> {
    throw new Error('No native history fixture installed.');
  }
  async fork(): Promise<{ sessionId: string }> {
    throw new Error('No native history fixture installed.');
  }
  async closeSession(_sessionId: string): Promise<void> {}
  async selectSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
  }
}
