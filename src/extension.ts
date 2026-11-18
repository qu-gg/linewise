import * as vscode from 'vscode';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { turnAttachments } from './context.js';
import { safeError, type OmpClient } from './acp.js';
import { assertPromptAllowed } from './history.js';
import type { Attachment, SavedSession, StateStore, Turn } from './state.js';
import type { HostTools } from './host-tools.js';
import { initializeStorage } from './storage-view.js';
import {
  artifactsDirectory,
  resumeArtifact,
  startupArguments,
  startupConfig,
  selectCopilotModel,
  createConnection,
  bindConnectedSession,
  configureSession,
} from './session-start.js';
import { branchConversation, historyBoundary } from './conversation.js';
import { runPrompt, startTurn } from './session-prompt.js';
import {
  applyNotification,
  configPresentation,
  connectionPresentation,
  sessionPresentation,
} from './session-presentation.js';
import { HostView, type SidebarRequest } from './host-view.js';
import { HostOperations, type Operation } from './host-operations.js';
import { registerHostCommands, testSurface } from './host-activation.js';

const execute = promisify(execFile);
let application: OmpView | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('OMP');
  let owner: OmpView;
  const storage = await initializeStorage(context, (action) =>
    owner.perform(() => owner.manageStorage(action)),
  );
  owner = application = new OmpView(context, storage, output);
  await application.initialize();
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('omp.chat', application),
  );
  registerHostCommands(context, output, application);
  return {
    status: () => application?.snapshot(),
    ...testSurface(context, storage, application),
  };
}

export async function deactivate(): Promise<void> {
  await application?.dispose();
}

class OmpView extends HostOperations implements vscode.WebviewViewProvider {
  private readonly view: HostView;
  private client: OmpClient | undefined;
  private tools: HostTools | undefined;
  private currentTurn: Turn | undefined;
  private turnAbort: AbortController | undefined;
  private compacting = false;
  private commands: string[] = [];
  private error = '';

  protected operationStarted(kind: Operation): void {
    if (['connect', 'history', 'disconnect'].includes(kind)) this.view.followUps.clear();
    this.error = '';
    this.publish();
  }

  protected operationSettled(status?: Turn['status']): void {
    if (status) this.view.followUps.settle(status);
    this.publish();
  }

  manageStorage(action: () => Promise<void>): Promise<void> {
    return this.idleOperation('storage', () => this.view.maintain(action));
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly output: vscode.OutputChannel,
  ) {
    super();
    this.view = new HostView(context, store, output, {
      snapshot: () => this.snapshot(),
      dispatch: (request) => this.route(request),
      perform: (action) => this.perform(action),
      fileOwner: () => this.fileApprovalOwner(),
      idle: (kind, action) => this.idleOperation(kind, action),
      busy: () => this.busy,
      available: () => !this.operation,
      drain: () => this.drainQueue(),
    });
  }

  initialize(): Promise<void> {
    return this.view.initialize();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view.chat.resolve(view);
  }

  async dispatch(message: unknown): Promise<void> {
    return this.view.dispatch(message);
  }

  private async route(request: SidebarRequest): Promise<void> {
    switch (request.type) {
      case 'connect':
        await this.connect();
        break;
      case 'disconnect':
        await this.disconnect();
        break;
      case 'new':
        await this.connect(true);
        break;
      case 'sessions':
        await this.switchSession();
        break;
      case 'cancel':
        await this.cancel();
        break;
      default:
        return this.conversationRequest(request);
    }
  }

  private async conversationRequest(request: SidebarRequest): Promise<void> {
    switch (request.type) {
      case 'prompt':
        await this.view.followUps.run(
          () => this.prompt(request.text),
          () => this.drainQueue(),
        );
        break;
      case 'editPrompt': {
        await this.view.editPrompt(request.id, () =>
          this.branchHistory(request.id, 'before', request.text),
        );
        break;
      }
      case 'forkTurn':
        await this.branchHistory(request.id, request.boundary);
        break;
      case 'permissions':
        await this.idleOperation('config', async () => {
          if (!this.tools) throw new Error('Start a session before changing permissions.');
          await this.tools.pickPermissions();
        });
        break;
      case 'config': {
        await this.configure(request.id, request.value);
        break;
      }
      case 'compact':
        await this.sessionCommand('compact');
        break;
      case 'inspectContext':
        await this.sessionCommand('context');
        break;
    }
  }

  async perform(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.error = safeError(error);
      this.output.appendLine(this.error);
      this.publish();
    }
  }

  private executable(): string {
    return vscode.workspace.getConfiguration('omp').get<string>('executablePath', 'omp');
  }

  async preflight(): Promise<void> {
    return this.view.preflight(this.executable(), execute);
  }

  async connect(fresh = false, selected?: SavedSession): Promise<void> {
    const operation = this.beginOperation('connect');
    this.commands = [];
    try {
      await this.finishTools();
      await this.client?.stop();
      const saved = selected ?? (fresh ? undefined : this.view.active());
      const root = this.view.root(saved);
      const artifacts = await artifactsDirectory(this.store.directory);
      const sessionFile = await resumeArtifact(artifacts, saved);
      const result = await execute(
        this.executable(),
        ['config', 'get', 'memory.backend', '--json'],
        { cwd: root.uri.fsPath, timeout: 15_000, maxBuffer: 65536 },
      );
      const fixture =
        this.context.extensionMode === vscode.ExtensionMode.Test
          ? process.env.VS_OMP_TEST_FIXTURE
          : undefined;
      const config = await startupConfig(
        this.store.directory,
        JSON.parse(result.stdout).value,
        fixture,
      );
      const { tools, client } = createConnection(
        this.view.files,
        this.view.journal,
        artifacts,
        this.view.chat.requestApproval,
        {
          update: (notification) => this.update(notification),
          closed: (closed, owned) => this.clientClosed(closed, owned),
          log: (message) => this.output.append(message),
        },
      );
      this.tools = tools;
      this.client = client;
      await client.start({
        executable: this.executable(),
        cwd: root.uri.fsPath,
        artifacts,
        sessionFile,
        args: startupArguments(
          config,
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'omp-guard.js').fsPath,
          artifacts,
          fixture,
        ),
      });
      if (!client.sessionId) throw new Error('OMP did not return a session identifier.');
      await selectCopilotModel(
        client,
        vscode.workspace.getConfiguration('omp').get<string>('model', ''),
      );
      if (
        await bindConnectedSession(
          this.store,
          client,
          { uri: root.uri.toString(), name: root.name },
          saved,
        )
      ) {
        this.error =
          'Recovered an interrupted conversation edit. Its full original is in Switch Session. Files were not changed.';
      }
      await this.view.journal.refresh();
      await this.store.save();
    } catch (error) {
      await this.client?.stop();
      throw error;
    } finally {
      this.endOperation(operation);
    }
  }

  async switchSession(): Promise<void> {
    const picked = await this.idleOperation('select', async () =>
      vscode.window.showQuickPick(
        this.store.data.sessions.map((session) => ({
          label: session.label,
          description: vscode.Uri.parse(session.root).fsPath,
          detail: session.id,
          session,
        })),
        { title: 'OMP Sessions' },
      ),
    );
    if (picked) await this.connect(false, picked.session);
  }

  private async sessionCommand(command: 'compact' | 'context'): Promise<void> {
    if (!this.client?.connected || !this.commands.includes(command))
      throw new Error(`OMP has not advertised /${command} for this session.`);
    if (this.operation)
      throw new Error('Wait for the current operation before running a session command.');
    this.compacting = command === 'compact';
    this.publish();
    try {
      await this.prompt(`/${command}`, false);
    } finally {
      const usage = command === 'compact' ? this.view.active()?.usage : undefined;
      if (usage) usage.stale = true;
      this.compacting = false;
      this.publish();
      if (usage) await this.store.save();
    }
  }

  private async branchHistory(
    id: string,
    boundary: 'before' | 'after',
    replacement?: string,
  ): Promise<void> {
    if (this.operation) throw new Error('Wait for the current operation before changing history.');
    const target = historyBoundary(this.client, this.view.active(), id, boundary);
    const { selected } = target;
    const operation = this.beginOperation('history');
    try {
      const cloned = await branchConversation(
        this.store,
        target,
        boundary,
        replacement !== undefined,
        () => this.tools!.resetPermissions(),
      );
      if (cloned) this.view.attachments.restore(cloned.id, selected, boundary === 'before');
    } finally {
      this.endOperation(operation);
    }
    if (replacement !== undefined) await this.prompt(replacement, false, turnAttachments(selected));
    else if (boundary === 'before')
      this.view.chat.post({ v: 1, type: 'draft', text: selected.prompt });
  }

  private async prompt(
    text: string,
    attach = true,
    originalAttachment?: Attachment | Attachment[],
  ): Promise<void> {
    if (this.operation) throw new Error('Wait for the current operation before sending a prompt.');
    assertPromptAllowed(text);
    const attachmentOwner = this.view.owner();
    const attached = this.view.attachments.capture(attachmentOwner, originalAttachment, attach);
    if (!this.client?.connected) await this.connect();
    const client = this.client!;
    const tools = this.tools!;
    const session = this.view.active();
    if (!session) throw new Error('No active session.');
    const operation = this.beginOperation('prompt');
    const abort = new AbortController();
    this.turnAbort = abort;
    const current = startTurn(session, text, attached);
    this.currentTurn = current;
    if (attach) this.view.attachments.clear(attachmentOwner);
    this.publish();
    try {
      await runPrompt({
        client,
        tools,
        store: this.store,
        session,
        current,
        attached,
        abort,
        cwd: vscode.Uri.parse(session.root).fsPath,
        valid: () => this.client === client && this.currentTurn === current && this.busy,
        release: () => {
          if (this.currentTurn === current) {
            this.currentTurn = undefined;
            this.turnAbort = undefined;
          }
        },
        finishTools: () => this.finishTools(tools),
        log: (message) => this.output.appendLine(message),
      });
    } finally {
      this.endOperation(operation, current.status);
    }
  }

  private update(notification: SessionNotification): void {
    if (notification.sessionId !== this.client?.sessionId) return;
    this.commands = applyNotification(
      this.client!,
      this.view.active(),
      this.currentTurn,
      notification.update,
      this.commands,
      this.connecting,
    );
    this.publish();
  }

  private async drainQueue(): Promise<void> {
    const owner = this.view.owner();
    await this.view.followUps.drain(
      owner,
      () => this.view.owner() === owner && !this.operation && Boolean(this.client?.connected),
      async (item) => {
        await this.prompt(item.text, false, item.attachments);
      },
    );
    this.publish();
  }

  private clientClosed(client: OmpClient, tools: HostTools): void {
    if (this.client !== client) return;
    this.turnAbort?.abort();
    void this.finishTools(tools).catch(() => {});
    if (!['connect', 'disconnect', 'shutdown'].includes(this.operation?.kind ?? ''))
      this.error = 'OMP stopped unexpectedly. Reconnect to continue.';
    this.publish();
  }

  private fileApprovalOwner(): () => boolean {
    const turn = this.currentTurn;
    const client = this.client;
    const owner = this.operation;
    return () =>
      !!turn &&
      this.currentTurn === turn &&
      this.client === client &&
      this.operation === owner &&
      this.busy;
  }

  async cancel(): Promise<void> {
    if (this.operation && !this.busy) throw new Error('Wait for the current operation to finish.');
    this.view.followUps.clear(true);
    this.turnAbort?.abort();
    try {
      await this.finishTools();
    } finally {
      await this.client?.cancel();
    }
  }
  private async disconnect(): Promise<void> {
    if (this.busy) this.operation = undefined;
    await this.idleOperation('disconnect', async () => {
      this.turnAbort?.abort();
      try {
        await this.finishTools();
        await this.client?.cancel();
      } finally {
        await this.client?.stop();
      }
    });
  }
  async dispose(): Promise<void> {
    this.view.chat.dispose();
    this.view.followUps.clear();
    this.operation = { kind: 'shutdown' };
    this.turnAbort?.abort();
    try {
      await this.finishTools();
    } finally {
      try {
        await this.client?.stop();
      } finally {
        await this.store.save();
      }
    }
  }

  private async finishTools(tools = this.tools): Promise<void> {
    try {
      await tools?.finish();
    } catch (error) {
      this.error = 'Terminal cleanup failed; tool execution is disabled. See OMP output.';
      this.output.appendLine(this.error);
      this.publish();
      throw error;
    }
  }

  private async configure(id: string, value: string): Promise<void> {
    await this.idleOperation('config', () => configureSession(this.client, this.store, id, value));
  }

  snapshot() {
    return {
      ...connectionPresentation(this.client, this.view.active()),
      permissions: this.tools ? this.tools.permissions : 'rules',
      busy: Boolean(this.operation && !this.connecting),
      connecting: this.connecting,
      compacting: this.compacting,
      cancellable: this.busy,
      historyChanging: this.historyChanging,
      ...sessionPresentation(this.view.active()),
      sessionIds: this.view.sessionIds(),
      canCompact: this.commands.includes('compact'),
      canInspectContext: this.commands.includes('context'),
      host: vscode.env.remoteName ?? 'Local',
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      error: this.error,
      ...this.view.chat.approvals.snapshot(),
      ...this.view.attachments.presentation(this.view.owner()),
      ...this.view.followUps.snapshot(this.view.owner()),
      configs: configPresentation(this.client),
      changes: this.view.changes(),
    };
  }

  private publish(): void {
    this.view.chat.publish();
  }
}
