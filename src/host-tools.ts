import * as vscode from 'vscode';
import path from 'node:path';
import type {
  CreateTerminalRequest,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import type { ReviewJournal } from './review.js';
import type { WorkspaceFiles } from './workspace.js';
import type { TerminalManager } from './terminal.js';
import type { TerminalCommand } from './terminal.js';
import { MutationBroker, permissionInput, isReviewedService } from './mutations.js';
import type { Mutation } from './mutations.js';
import { checkedPath, checkedReadPath } from './file-policy.js';
import { commandDecision } from './terminal-policy.js';
import { CommandPermissions, permissionSetting } from './host-permissions.js';
import { executeShell } from './shell.js';
import { createTerminalManager, pickOwnedTerminal } from './host-terminals.js';
import { inspectEditor } from './host-inspect.js';
import { renameWorkspace } from './host-rename.js';
import { codeActionsWorkspace } from './host-code-actions.js';
import { editNotebook } from './host-notebook.js';
import { executeWorkspaceTask } from './host-tasks.js';
import { fetchWeb } from './host-fetch.js';
import { askQuestions } from './host-questions.js';
import type { RequestQuestions } from './questions.js';
import { SessionBrowser } from './browser.js';
import type { BrowserRequest } from './browser-policy.js';
import type { PermissionMode } from './terminal-policy.js';
import type { Provenance } from './review-types.js';
import { browserApproval, commandApproval } from './approval-prompts.js';
import type { RequestApproval } from './approvals.js';

export interface ToolScope {
  sessionId: string;
  owner: string;
  turnId?: string;
  cwd: string;
  signal: AbortSignal;
  valid(): boolean;
}

type ActiveScope = ToolScope & {
  reads: Set<string>;
  manager?: TerminalManager;
  broker?: MutationBroker;
  abort: AbortController;
};

export const toolConfiguration = {
  tools: { xdev: false, approvalMode: 'write' },
  bash: { direnv: 'off', autoBackground: { enabled: false } },
  async: { enabled: false },
  launch: { enabled: false },
};

export class HostTools {
  private scope: ActiveScope | undefined;
  private readonly browsers = new SessionBrowser();
  private closing: Promise<void> | undefined;
  private failed = false;
  private readonly commandPermissions = new CommandPermissions(() => this.assertPermissionIdle());
  constructor(
    private readonly files: Pick<WorkspaceFiles, 'normalize'> &
      Partial<Pick<WorkspaceFiles, 'isDirty'>>,
    private readonly journal: Pick<ReviewJournal, 'read' | 'write'> &
      Partial<Pick<ReviewJournal, 'authorizeRead' | 'inspect' | 'delete' | 'move'>>,
    private readonly mutationDirectory?: string,
    private readonly requestApproval: RequestApproval = async () => false,
    private readonly requestQuestions: RequestQuestions = askQuestions,
  ) {}
  begin(scope: ToolScope): void {
    if (this.scope || this.closing || this.failed)
      throw new Error('Previous tool scope has not closed safely.');
    const abort = new AbortController();
    this.scope = {
      ...scope,
      reads: new Set(),
      abort,
      signal: AbortSignal.any([scope.signal, abort.signal]),
    };
  }

  get cleanupFailed(): boolean {
    return this.failed;
  }

  private get privateRoot(): string | undefined {
    return this.mutationDirectory && path.dirname(this.mutationDirectory);
  }

  get permissions(): PermissionMode {
    return this.commandPermissions.value;
  }

  resetPermissions(): void {
    this.commandPermissions.reset();
  }

  pickPermissions(): Promise<void> {
    return this.commandPermissions.pick();
  }

  private assertPermissionIdle(): void {
    if (!vscode.workspace.isTrusted || this.scope || this.closing || this.failed)
      throw new Error(
        'Command permissions cannot change before command cleanup in a trusted workspace.',
      );
  }

  async run<Result>(scope: ToolScope, action: () => Promise<Result>): Promise<Result> {
    this.begin(scope);
    let completed = false;
    try {
      const active = this.current(scope.sessionId);
      await this.browsers.bind(JSON.stringify([scope.sessionId, scope.owner, scope.cwd]));
      this.assertCurrent(active);
      if (this.mutationDirectory) {
        active.broker = new MutationBroker(
          this.mutationDirectory,
          (mutation, toolCallId) => this.applyNative(active, mutation, toolCallId),
          active.signal,
        );
        await active.broker.start();
      }
      const result = await action();
      active.signal.throwIfAborted();
      completed = true;
      return result;
    } finally {
      await this.finish(completed);
    }
  }

  private current(sessionId: string): ActiveScope {
    const scope = this.scope;
    if (!scope || scope.sessionId !== sessionId || !scope.valid())
      throw new Error('No active prompt owns this tool request.');
    scope.signal.throwIfAborted();
    if (
      !vscode.workspace.isTrusted ||
      !vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === scope.cwd)
    )
      throw new Error('The trusted workspace root is no longer available.');
    return scope;
  }

  async read(request: ReadTextFileRequest): Promise<string> {
    const scope = this.current(request.sessionId);
    const approved = scope.reads.delete(request.path) ? request.path : undefined;
    const text = await this.journal.read(request.path, scope.signal, approved);
    if (this.current(request.sessionId) !== scope)
      throw new Error('Tool request belongs to a retired prompt.');
    return text
      .split('\n')
      .slice(
        (request.line ?? 1) - 1,
        (request.line ?? 1) - 1 + (request.limit ?? Number.MAX_SAFE_INTEGER),
      )
      .join('\n');
  }

  async write(request: WriteTextFileRequest): Promise<void> {
    const scope = this.current(request.sessionId);
    const content = await this.files.normalize(request.path, request.content);
    if (this.current(request.sessionId) !== scope)
      throw new Error('Tool request belongs to a retired prompt.');
    await this.journal.write(scope.owner, request.path, content, scope.signal, undefined, {
      turnId: scope.turnId,
      tool: 'write',
    });
  }

  async create(request: CreateTerminalRequest) {
    const scope = this.current(request.sessionId);
    return this.terminalManager(scope).create(request);
  }

  private terminalManager(scope: ActiveScope): TerminalManager {
    return (scope.manager ??= createTerminalManager(
      scope,
      (command, signal) => this.approve(scope, command, signal),
      () => this.assertCurrent(scope),
    ));
  }

  async pickTerminal(onCancel?: (sessionId: string) => void): Promise<void> {
    const scope = this.current(this.scope?.sessionId ?? '');
    await pickOwnedTerminal(
      this.terminalManager(scope),
      scope.sessionId,
      () => this.assertCurrent(scope),
      scope.signal,
      onCancel?.bind(undefined, scope.sessionId),
    );
  }

  async permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const scope = this.current(request.sessionId);
    const input = request.toolCall.rawInput;
    const once = request.options.find((option) => option.kind === 'allow_once');
    if (!once || !input || typeof input !== 'object') return { outcome: { outcome: 'cancelled' } };
    const value = permissionInput(input as Record<string, unknown>);
    const allowed = await scope.broker?.permit(request.toolCall.toolCallId, value);
    this.assertCurrent(scope);
    return {
      outcome: allowed
        ? { outcome: 'selected', optionId: once.optionId }
        : { outcome: 'cancelled' },
    };
  }

  private assertCurrent(scope: ActiveScope): void {
    if (this.current(scope.sessionId) !== scope)
      throw new Error('Native mutation belongs to a retired prompt.');
  }

  private async applyNative(
    scope: ActiveScope,
    mutation: Mutation,
    toolCallId?: string,
  ): Promise<string | null> {
    this.assertCurrent(scope);
    if ('request' in mutation) {
      const result = await this.nativeService(scope, mutation, toolCallId);
      this.assertCurrent(scope);
      return result;
    }
    if (mutation.op === 'access') return this.authorizeRead(scope, mutation.path);
    const provenance: Provenance = { turnId: scope.turnId, toolCallId, tool: 'edit' };
    const target = await checkedPath(mutation.path, scope.cwd, this.privateRoot);
    if (target !== mutation.path) throw new Error('Native mutation path changed after capture.');
    this.assertCurrent(scope);
    if (mutation.op === 'read') {
      if (!this.journal.inspect) throw new Error('Native mutation journal is unavailable.');
      return this.journal.inspect(target, scope.signal);
    }
    if (mutation.op === 'write') return this.applyNativeWrite(scope, mutation, target, provenance);
    await this.applyDestructive(scope, mutation, target, provenance);
    return mutation.op === 'delete' ? '' : mutation.content;
  }

  private async applyNativeWrite(
    scope: ActiveScope,
    mutation: Extract<Mutation, { op: 'write' }>,
    target: string,
    provenance: Provenance,
  ): Promise<string> {
    const content = await this.files.normalize(target, mutation.content);
    this.assertCurrent(scope);
    if (content.includes('#!')) throw new Error('Executable-bit side effects are disabled.');
    if (this.files.isDirty?.(target))
      throw new Error('Save or close the dirty buffer before applying a native edit.');
    await this.journal.write(
      scope.owner,
      target,
      content,
      scope.signal,
      mutation.before,
      provenance,
    );
    return content;
  }

  private async nativeService(
    scope: ActiveScope,
    mutation: Extract<Mutation, { request: unknown }>,
    toolCallId?: string,
  ): Promise<string> {
    const serviceScope = {
      sessionId: scope.sessionId,
      cwd: scope.cwd,
      privateRoot: this.privateRoot,
      signal: scope.signal,
      valid: () => {
        this.assertCurrent(scope);
        return true;
      },
    };
    if (mutation.op === 'fetch')
      return fetchWeb(mutation.request, serviceScope, this.requestApproval);
    if (mutation.op === 'task')
      return executeWorkspaceTask(mutation.request, serviceScope, this.terminalManager(scope));
    if (isReviewedService(mutation)) {
      const write = async (image: Parameters<Parameters<typeof renameWorkspace>[2]>[0]) => {
        this.assertCurrent(scope);
        await this.journal.write(
          scope.owner,
          image.path,
          image.content,
          scope.signal,
          image.before,
          {
            turnId: scope.turnId,
            toolCallId,
            tool: mutation.op,
          },
        );
      };
      if (mutation.op === 'notebook_edit')
        return editNotebook(mutation.request, serviceScope, write);
      return mutation.op === 'rename'
        ? renameWorkspace(mutation.request, serviceScope, write)
        : codeActionsWorkspace(mutation.request, serviceScope, write);
    }
    if (mutation.op === 'questions')
      return this.requestQuestions(mutation.request, scope.signal, serviceScope.valid);
    if (mutation.op === 'browser') return this.browser(scope, mutation.request);
    if (mutation.op === 'editor') return inspectEditor(mutation.request, serviceScope);
    return executeShell(
      this.terminalManager(scope),
      scope.sessionId,
      scope.cwd,
      mutation.request,
      scope.signal,
    );
  }

  private async authorizeRead(scope: ActiveScope, captured: string): Promise<null> {
    if (!this.journal.authorizeRead || scope.reads.size >= 256)
      throw new Error('Read authorization is unavailable.');
    const target = await checkedReadPath(captured, scope.cwd, this.privateRoot);
    if (target !== captured) throw new Error('Read path changed after capture.');
    await this.journal.authorizeRead(target, scope.signal);
    this.assertCurrent(scope);
    scope.reads.add(target);
    return null;
  }

  private browser(scope: ActiveScope, request: BrowserRequest): Promise<string> {
    const config = vscode.workspace
      .getConfiguration('omp')
      .inspect<string>('browser.executablePath');
    const executablePath = config?.globalValue || undefined;
    if (executablePath && !path.isAbsolute(executablePath))
      throw new Error('Configure an absolute user browser executable path.');
    return this.browsers.execute(
      JSON.stringify([scope.sessionId, scope.owner, scope.cwd]),
      request,
      {
        signal: scope.signal,
        executablePath,
        approve: async (request: BrowserRequest, signal) => {
          this.assertCurrent(scope);
          const approved = await this.requestApproval(
            browserApproval(request, executablePath),
            signal,
            () => this.current(scope.sessionId) === scope,
          );
          this.assertCurrent(scope);
          return approved;
        },
      },
    );
  }

  private async applyDestructive(
    scope: ActiveScope,
    mutation: Extract<Mutation, { op: 'delete' | 'move' }>,
    target: string,
    provenance: Provenance,
  ): Promise<void> {
    if (mutation.op === 'delete') {
      if (!this.journal.delete) throw new Error('Native mutation journal is unavailable.');
      await this.journal.delete(scope.owner, target, scope.signal, mutation.before, provenance);
    } else if (this.journal.move) {
      const destination = await checkedPath(
        mutation.destination,
        scope.cwd,
        this.mutationDirectory && path.dirname(this.mutationDirectory),
      );
      if (destination !== mutation.destination)
        throw new Error('Native mutation path changed after capture.');
      this.assertCurrent(scope);
      if (mutation.content.includes('#!'))
        throw new Error('Executable-bit side effects are disabled.');
      await this.journal.move(
        scope.owner,
        target,
        destination,
        scope.signal,
        {
          before: mutation.before,
          after: mutation.content,
        },
        provenance,
      );
    } else throw new Error('Native mutation journal is unavailable.');
  }

  private async approve(
    scope: ActiveScope,
    command: Readonly<TerminalCommand>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.current(scope.sessionId) !== scope) throw new Error('Terminal approval is stale.');
    signal.throwIfAborted();
    const decide = () =>
      commandDecision(
        command,
        this.permissions,
        permissionSetting('commandRules', []),
        permissionSetting('useDefaultRules', true),
      );
    const decision = decide();
    if (decision === 'deny')
      throw new Error('Command blocked by an OMP user rule or YOLO safety restriction.');
    if (decision === 'allow') return true;
    const approved = await this.requestApproval(
      commandApproval(command),
      signal,
      () => this.current(scope.sessionId) === scope,
    );
    signal.throwIfAborted();
    if (this.current(scope.sessionId) !== scope) throw new Error('Terminal approval is stale.');
    if (decide() === 'deny')
      throw new Error('Command blocked by an OMP user rule or YOLO safety restriction.');
    return approved;
  }

  private manager(request: TerminalOutputRequest): TerminalManager {
    const manager = this.current(request.sessionId).manager;
    if (!manager) throw new Error('No terminal belongs to this prompt.');
    return manager;
  }

  output(request: TerminalOutputRequest) {
    return this.manager(request).output(request);
  }
  waitForExit(request: TerminalOutputRequest) {
    return this.manager(request).waitForExit(request);
  }
  kill(request: TerminalOutputRequest) {
    return this.manager(request).kill(request);
  }
  release(request: TerminalOutputRequest) {
    return this.manager(request).release(request);
  }

  browserUrl(): string | undefined {
    return this.browsers.currentUrl();
  }

  closeBrowser(): Promise<void> {
    return this.browsers.revoke();
  }

  finish(preserveBrowser = false): Promise<void> {
    if (this.failed)
      return Promise.reject(new Error('Terminal cleanup failed; tool execution remains disabled.'));
    const browser = preserveBrowser ? undefined : this.closeBrowser();
    if (this.closing) return Promise.all([this.closing, browser]).then(() => {});
    const scope = this.scope;
    this.scope = undefined;
    scope?.abort.abort();
    this.closing = Promise.all([scope?.manager?.dispose(), browser, scope?.broker?.close()])
      .then(() => {})
      .catch((cause: unknown) => {
        this.failed = true;
        throw new Error('Terminal cleanup failed; tool execution remains disabled.', { cause });
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}
