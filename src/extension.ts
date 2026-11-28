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
import { configureSession, establishConnection } from './session-start.js';
import { branchConversation, historyBoundary } from './conversation.js';
import { runPrompt, startTurn } from './session-prompt.js';
import {
  applyNotification,
  configPresentation,
  connectionPresentation,
  sessionPresentation,
} from './session-presentation.js';
import { HostView } from './host-view.js';
import { HostOperations, type Operation } from './host-operations.js';
import { registerHostCommands, testSurface } from './host-activation.js';
import { assertSessionResumable } from './sessions.js';
import { ModelRoutes, type AppliedRoute, type LaunchRoute } from './model-route.js';
import { OpenRouterRoutes } from './model-routes.js';
import { routeRequest, type RequestHandlers } from './request-router.js';
import { openIntegratedBrowser } from './integrated-browser.js';
import { defaultPermissionMode } from './host-permissions.js';
import { retryLastTurn } from './retry-turn.js';
import type { PermissionMode } from './terminal-policy.js';

const execute = promisify(execFile);
let application: OmpView | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Linewise');
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
    ...testSurface(context, storage, application, application.attach),
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
  private permissionMode: PermissionMode | undefined;
  private activeRoute: AppliedRoute | undefined;
  private readonly providerCatalog = new OpenRouterRoutes();
  private readonly modelRoutes = new ModelRoutes(
    (model) => this.providerCatalog.providers(model),
    () => this.publish(),
    () => this.client,
    () => this.view.active(),
    (session) => this.view.journal.list(session.id).length,
  );

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
      dispatch: (request) => routeRequest(request, this.handlers),
      perform: (action) => this.perform(action),
      fileOwner: () => this.fileApprovalOwner(),
      idle: (kind, action) => this.idleOperation(kind, action),
      busy: () => this.busy,
      available: () => !this.operation,
      drain: () => this.drainQueue(),
      disconnect: () => this.disconnect(),
      resume: (session) => this.connect(false, session),
    });
  }

  initialize = () => this.view.initialize();

  resolveWebviewView = (view: vscode.WebviewView) => this.view.chat.resolve(view);

  dispatch = (message: unknown): Promise<void> => this.view.dispatch(message);

  attach = (snapshots: Attachment[]) => this.view.addSnapshots(snapshots);

  private readonly handlers: RequestHandlers = {
    connect: () => this.connect(),
    disconnect: () => this.disconnect(),
    newSession: () => {
      this.modelRoutes.clear();
      return this.connect(true);
    },
    switchSession: () => this.switchSession(),
    cancel: () => this.cancel(),
    postModelCatalog: () => {
      if (this.client && !this.operation) this.view.chat.postModelCatalog(this.client);
    },
    selectModelRoute: (value) =>
      this.idleOperation('config', async () => this.modelRoutes.select(value)),
    prompt: (text) =>
      this.view.followUps.run(
        () => this.prompt(text),
        () => this.drainQueue(),
      ),
    editPrompt: (id, text) =>
      this.view.editPrompt(id, () => this.branchHistory(id, 'before', text)),
    forkTurn: (id, boundary) => this.branchHistory(id, boundary),
    retryTurn: (id) =>
      retryLastTurn(this.view, id, (id, prompt) => this.branchHistory(id, 'before', prompt, false)),
    permissions: (mode, confirmed) =>
      this.idleOperation('config', async () => {
        if (!this.tools) throw new Error('Start a session before changing permissions.');
        this.tools.setPermissions(mode, confirmed);
        this.permissionMode = this.tools.permissions;
      }),
    permissionSettings: async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@id:omp.permissions.commandRules',
      );
    },
    terminals: () => this.tools?.pickTerminal(this.view.chat.focusTerminals),
    config: (id, value) => this.configure(id, value),
    openInBrowser: () => this.openInBrowser(),
    sessionCommand: (command) => this.sessionCommand(command),
  };

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

  private prepareConnect(fresh: boolean, selected?: SavedSession) {
    const active = this.view.active();
    if (fresh)
      this.output.appendLine(`New chat: replacing ${active ? active.id : 'no active chat'}.`);
    return {
      saved: selected ?? (fresh ? undefined : active),
      replace: fresh ? active : undefined,
    };
  }

  async connect(fresh = false, selected?: SavedSession, launch?: LaunchRoute): Promise<void> {
    const { saved, replace } = this.prepareConnect(fresh, selected);
    this.modelRoutes.clearPendingFor(fresh, selected, launch);
    this.activeRoute = undefined;
    assertSessionResumable(saved);
    const permissions = this.connectionPermissionMode();
    const operation = this.beginOperation('connect');
    this.commands = [];
    try {
      await this.finishTools();
      await this.client?.stop();
      await establishConnection({
        view: this.view,
        store: this.store,
        executable: this.executable(),
        run: execute,
        guard: vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'omp-guard.js').fsPath,
        fixture:
          this.context.extensionMode === vscode.ExtensionMode.Test
            ? process.env.VS_OMP_TEST_FIXTURE
            : undefined,
        configuredModel: vscode.workspace.getConfiguration('omp').get<string>('model', ''),
        permissions,
        saved,
        replace,
        launch,
        update: (notification) => this.update(notification),
        closed: (closed, owned) => this.clientClosed(closed, owned),
        setClient: (client, tools) => {
          this.client = client;
          this.tools = tools;
        },
        setError: (message) => {
          this.error = message;
        },
        log: (message) => this.output.append(message),
        clearPending: () => this.modelRoutes.clearPending(),
        refreshRoutes: () => void this.modelRoutes.refresh(),
      });
      this.permissionMode = permissions;
      if (launch) this.activeRoute = { provider: launch.provider, label: launch.label };
    } catch (error) {
      try {
        await this.client?.stop();
      } finally {
        this.client = undefined;
        if (!this.tools?.cleanupFailed) this.tools = undefined;
      }
      throw error;
    } finally {
      this.endOperation(operation);
    }
  }
  switchSession = () => this.view.switchSession();
  private async sessionCommand(command: 'compact' | 'context'): Promise<void> {
    if (!this.client?.connected || !this.commands.includes(command))
      throw new Error(`OMP has not advertised /${command} for this session.`);
    if (this.operation)
      throw new Error('Wait for the current operation before running a session command.');
    const usage = command === 'compact' ? this.view.active()?.usage : undefined;
    if (usage) usage.stale = true;
    this.compacting = command === 'compact';
    this.publish();
    try {
      await this.prompt(`/${command}`, false);
    } finally {
      this.compacting = false;
      this.publish();
      if (usage) await this.store.save();
    }
  }

  private async branchHistory(
    id: string,
    boundary: 'before' | 'after',
    replacement?: string,
    resetPermissions = true,
  ): Promise<void> {
    if (this.operation) throw new Error('Wait for the current operation before changing history.');
    const target = historyBoundary(this.client, this.view.active(), id, boundary);
    const { selected } = target;
    const operation = this.beginOperation('history');
    try {
      await this.closeBrowser();
      const cloned = await branchConversation(
        this.store,
        target,
        boundary,
        replacement !== undefined,
        resetPermissions ? () => this.resetPermissionMode() : () => {},
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
    if (this.operation)
      throw new Error(
        this.operation.kind === 'config'
          ? 'Finish the current permission or model change before sending a prompt.'
          : 'Wait for the current operation before sending a prompt.',
      );
    assertPromptAllowed(text);
    const attachmentOwner = this.view.owner();
    const attached = this.view.attachments.capture(attachmentOwner, originalAttachment, attach);
    const launch = this.modelRoutes.pendingLaunch();
    if (launch) await this.connect(true, undefined, launch);
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
        sendLive: (message) => this.view.chat.post(message),
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

  closeBrowser = () => this.tools?.closeBrowser() ?? Promise.resolve();

  async openInBrowser(url?: string) {
    const target = url ?? this.tools?.browserUrl();
    if (!target) throw new Error('No owned browser page is open.');
    await openIntegratedBrowser(target, this.output);
  }

  async cancel(): Promise<void> {
    if (this.operation && !this.busy) throw new Error('Wait for the current operation to finish.');
    this.view.followUps.clear(true);
    const cancelled = this.client?.cancel();
    this.turnAbort?.abort();
    try {
      await cancelled;
    } finally {
      await this.finishTools();
    }
  }
  private async disconnect(): Promise<void> {
    if (this.busy) this.operation = undefined;
    this.activeRoute = undefined;
    this.modelRoutes.clear();
    await this.idleOperation('disconnect', async () => {
      const client = this.client;
      const stopped = client?.stop();
      this.turnAbort?.abort();
      try {
        await stopped;
        await client?.cancel();
      } finally {
        await this.finishTools();
      }
    });
  }
  async dispose(): Promise<void> {
    this.view.chat.dispose();
    this.view.followUps.clear();
    this.operation = { kind: 'shutdown' };
    try {
      const stopped = this.client?.stop(true);
      this.turnAbort?.abort();
      await stopped;
    } finally {
      try {
        await this.finishTools();
      } finally {
        await this.store.save();
      }
    }
  }
  private connectionPermissionMode(): PermissionMode {
    if (!vscode.workspace.isTrusted) this.permissionMode = undefined;
    return this.permissionMode ?? defaultPermissionMode();
  }
  private resetPermissionMode(): void {
    if (this.permissionMode !== 'all' && this.permissionMode !== 'yolo') return;
    this.tools?.resetPermissions();
    this.permissionMode = this.tools?.permissions ?? defaultPermissionMode();
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
    await this.idleOperation('config', async () => {
      await configureSession(this.client, this.store, id, value);
      if (id === 'model') {
        this.modelRoutes.modelChanged();
        this.activeRoute = undefined;
      }
    });
    if (id === 'model') void this.modelRoutes.refresh();
  }

  snapshot() {
    return {
      ...connectionPresentation(this.client, this.view.active()),
      permissions: this.permissionMode ?? 'rules',
      busy: Boolean(this.operation && !this.connecting),
      connecting: this.connecting,
      compacting: this.compacting,
      cancellable: this.busy,
      historyChanging: this.historyChanging,
      ...sessionPresentation(this.view.active()),
      ...this.view.sessionPresentation(),
      canCompact: this.commands.includes('compact'),
      canInspectContext: this.commands.includes('context'),
      browserUrl: this.tools?.browserUrl() ?? '',
      host: vscode.env.remoteName ?? 'Local',
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      error: this.error,
      ...this.view.chat.presentation(),
      ...this.view.contextPresentation(),
      ...this.view.followUps.snapshot(this.view.owner()),
      configs: configPresentation(this.client, this.activeRoute),
      modelRoute: this.modelRoutes.presentation(),
      changes: this.view.changes(),
    };
  }

  private publish = () => this.view.chat.publish();
}
