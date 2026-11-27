import { ClientApp, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  ContentBlock,
  InitializeResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { z } from 'zod';
import { exchangeHistory, historyCommand } from './history.js';
import type { HistoryOperation, HistorySnapshot } from './history.js';
import type { TerminalManager } from './terminal.js';
import type { ImagePayload } from './image-policy.js';

export interface ClientHandlers {
  closed?(): void;
  update(notification: SessionNotification): Promise<void>;
  read(request: ReadTextFileRequest): Promise<string>;
  write(request: WriteTextFileRequest): Promise<void>;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  terminals?: Pick<TerminalManager, 'create' | 'output' | 'waitForExit' | 'kill' | 'release'>;
}

interface StartOptions {
  executable: string;
  cwd: string;
  args: string[];
  artifacts: string;
  sessionId?: string;
  sessionFile?: string;
}

export function promptBlocks(
  text: string,
  attached?:
    | { uri: string; text: string; image?: ImagePayload }
    | { uri: string; text: string; image?: ImagePayload }[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const snapshot of attached ? (Array.isArray(attached) ? attached : [attached]) : []) {
    if (snapshot.image) {
      blocks.push({ type: 'text', text: snapshot.text }, { type: 'image', ...snapshot.image });
      continue;
    }
    blocks.push({
      type: 'resource',
      resource: { uri: snapshot.uri, mimeType: 'text/plain', text: snapshot.text },
    });
  }
  return blocks;
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /(?:Bearer\s+\S+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|(?:access_token|api[_-]?key)\s*[:=]\s*["']?[\w.-]+)/gi,
    '[redacted]',
  );
}

function terminals(handlers: ClientHandlers) {
  if (!handlers.terminals) throw new Error('No approved terminal backend; access denied.');
  return handlers.terminals;
}

export function createClientApp(handlers: ClientHandlers): ClientApp {
  return new ClientApp({ name: 'vs-omp' })
    .onNotification('session/update', async ({ params }) => {
      await handlers.update(params);
    })
    .onNotification('*', async () => {})
    .onRequest('fs/read_text_file', async ({ params }) => ({
      content: await handlers.read(params),
    }))
    .onRequest('fs/write_text_file', async ({ params }) => {
      await handlers.write(params);
      return {};
    })
    .onRequest('session/request_permission', async ({ params }) => handlers.permission(params))
    .onRequest('terminal/create', ({ params }) => terminals(handlers).create(params))
    .onRequest('terminal/output', ({ params }) => terminals(handlers).output(params))
    .onRequest('terminal/wait_for_exit', ({ params }) => terminals(handlers).waitForExit(params))
    .onRequest('terminal/kill', ({ params }) => terminals(handlers).kill(params))
    .onRequest('terminal/release', ({ params }) => terminals(handlers).release(params))
    .onRequest('*', async () => {
      throw new Error('Unsupported client operation; access denied.');
    });
}

export class OmpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: ClientConnection | undefined;
  private exit: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private historyDirectory = '';
  private running = false;
  private cwd = '';
  historyAvailable = false;
  sessionId: string | undefined;
  configOptions: SessionConfigOption[] = [];
  info: InitializeResponse | undefined;

  get connected(): boolean {
    return Boolean(this.connection && !this.connection.signal.aborted);
  }

  constructor(
    private readonly handlers: ClientHandlers,
    private readonly log: (message: string) => void,
  ) {}

  private launch(options: StartOptions): ChildProcessWithoutNullStreams {
    const child = spawn(options.executable, ['acp', ...options.args], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Linewise registers a hashline edit tool; OMP otherwise falls back to
        // replace mode for some models, dropping read line numbers and tags.
        PI_EDIT_VARIANT: 'hashline',
        PI_STRICT_EDIT_MODE: '1',
        VS_OMP_ARTIFACTS_ROOT: options.artifacts,
        VS_OMP_HISTORY_DIR: this.historyDirectory,
      },
    });
    this.child = child;
    this.exit = new Promise((resolve) => {
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    });
    void this.exit.then(() => {
      if (this.child !== child) return;
      this.connection?.close();
      this.configOptions = [];
      this.historyAvailable = false;
      this.handlers.closed?.();
    });
    child.stderr.on('data', (chunk) => {
      this.log(safeError(chunk).slice(0, 4096));
    });
    return child;
  }

  private async openSession(options: StartOptions, connection: ClientConnection): Promise<void> {
    this.sessionId = options.sessionFile ? undefined : options.sessionId;
    const result =
      options.sessionId && !options.sessionFile
        ? await connection.agent.request(
            'session/load',
            { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] },
            { cancellationSignal: AbortSignal.timeout(20_000) },
          )
        : await connection.agent.request(
            'session/new',
            { cwd: options.cwd, mcpServers: [] },
            { cancellationSignal: AbortSignal.timeout(20_000) },
          );
    if ('sessionId' in result && typeof result.sessionId === 'string')
      this.sessionId = result.sessionId;
    this.configOptions = result.configOptions ?? [];
  }

  async start(options: StartOptions): Promise<void> {
    if (this.child || this.stopping) throw new Error('An OMP process is already active.');
    let advertised = () => {};
    const commandsReady = new Promise<void>((resolve) => {
      advertised = resolve;
    });
    this.cwd = options.cwd;
    this.historyDirectory = path.join(options.artifacts, 'control');
    this.historyAvailable = false;
    const child = this.launch(options);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const connection = createClientApp({
        ...this.handlers,
        update: async (notification) => {
          if (notification.update.sessionUpdate === 'available_commands_update') {
            this.historyAvailable = notification.update.availableCommands.some(
              (command) => command.name === historyCommand,
            );
            advertised();
            notification = {
              ...notification,
              update: {
                ...notification.update,
                availableCommands: notification.update.availableCommands.filter(
                  (command) => command.name !== historyCommand,
                ),
              },
            };
          }
          await this.handlers.update(notification);
        },
      }).connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
      this.connection = connection;
      this.info = await connection.agent.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'vs-omp', version: '0.0.1' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            ...(this.handlers.terminals && process.platform === 'linux' ? { terminal: true } : {}),
          },
        },
        { cancellationSignal: AbortSignal.timeout(15_000) },
      );
      if (
        this.info.protocolVersion !== PROTOCOL_VERSION ||
        this.info.agentInfo?.version !== '18.21.0'
      ) {
        throw new Error('This feasibility build supports OMP 18.21.0 with ACP v1 only.');
      }
      await this.openSession(options, connection);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('OMP did not advertise its session commands.')),
          5_000,
        );
        void commandsReady.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (options.sessionFile) {
        await this.history({ action: 'resume', fileName: options.sessionFile });
        await this.selectSession(this.sessionId!);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async prompt(prompt: ContentBlock[]) {
    if (!this.connection || !this.sessionId) throw new Error('Start an OMP session first.');
    return this.exclusive(() =>
      this.connection!.agent.request('session/prompt', { sessionId: this.sessionId!, prompt }),
    );
  }

  async setConfig(configId: string, value: string): Promise<void> {
    if (!this.connection || !this.sessionId) throw new Error('Start an OMP session first.');
    const result = await this.exclusive(() =>
      this.connection!.agent.request('session/set_config_option', {
        sessionId: this.sessionId!,
        configId,
        value,
      }),
    );
    this.configOptions = result.configOptions;
  }

  private async exclusive<Result>(action: () => Promise<Result>): Promise<Result> {
    if (this.running) throw new Error('Wait for the current OMP operation.');
    this.running = true;
    try {
      return await action();
    } finally {
      this.running = false;
    }
  }

  async history(
    operation: HistoryOperation = { action: 'inspect' },
    sessionId = this.sessionId,
  ): Promise<HistorySnapshot> {
    if (!this.connected || !sessionId || !this.historyAvailable)
      throw new Error('Native history control is unavailable.');
    return this.exclusive(() =>
      exchangeHistory(
        this.historyDirectory,
        (text) =>
          this.connection!.agent.request(
            'session/prompt',
            {
              sessionId,
              prompt: [{ type: 'text', text }],
            },
            { cancellationSignal: AbortSignal.timeout(15_000) },
          ),
        operation,
      ),
    );
  }

  async fork() {
    const capabilities = this.info?.agentCapabilities?.sessionCapabilities;
    if (!this.connection || !this.sessionId || !capabilities || !('fork' in capabilities))
      throw new Error('Session forking is unavailable.');
    const result = await this.exclusive(() =>
      this.connection!.agent.request(
        'session/fork',
        { sessionId: this.sessionId!, cwd: this.cwd, mcpServers: [] },
        { cancellationSignal: AbortSignal.timeout(20_000) },
      ),
    );
    const fork = z.object({ sessionId: z.string().min(1) }).parse(result);
    if (fork.sessionId === this.sessionId)
      throw new Error('OMP did not create an independent fork identity.');
    return fork;
  }

  async closeSession(sessionId: string): Promise<void> {
    if (sessionId === this.sessionId) throw new Error('Disconnect to close the active session.');
    await this.exclusive(() => this.connection!.agent.request('session/close', { sessionId }));
  }

  async selectSession(sessionId: string): Promise<void> {
    const result = await this.exclusive(() =>
      this.connection!.agent.request(
        'session/load',
        { sessionId, cwd: this.cwd, mcpServers: [] },
        { cancellationSignal: AbortSignal.timeout(20_000) },
      ),
    );
    this.sessionId = sessionId;
    this.configOptions = result.configOptions ?? [];
  }

  async cancel(): Promise<void> {
    if (this.connection && this.sessionId)
      await this.connection.agent.notify('session/cancel', { sessionId: this.sessionId });
  }

  async stop(immediate = false): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopping = (async () => {
      child.kill(immediate ? 'SIGKILL' : 'SIGTERM');
      this.connection?.close();
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      try {
        await this.exit;
      } finally {
        clearTimeout(timer);
        this.child = undefined;
        this.connection = undefined;
        this.sessionId = undefined;
        this.configOptions = [];
        this.historyAvailable = false;
      }
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }
}

export function selectOptions(
  option: SessionConfigOption,
): { value: string; name: string; description?: string }[] {
  return option.type === 'select'
    ? option.options
        .flatMap((item) => ('group' in item ? item.options : [item]))
        .map((item) => ({
          value: item.value,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
        }))
    : [];
}
