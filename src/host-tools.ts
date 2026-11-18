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
import { TerminalManager } from './terminal.js';
import type { TerminalCommand } from './terminal.js';
import { MutationBroker } from './mutations.js';
import type { Mutation } from './mutations.js';
import { checkedPath } from './file-policy.js';
import { commandDecision, permissionMode } from './terminal-policy.js';
import type { PermissionMode } from './terminal-policy.js';
import type { Provenance } from './review-types.js';
import { commandApproval } from './approval-prompts.js';
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

function permissionInput(input: Record<string, unknown>): string | undefined {
  if (Object.keys(input).length !== 1) return;
  if (typeof input.input === 'string') return input.input;
  if (typeof input.command === 'string') return JSON.stringify({ command: input.command });
}

function permissionSetting<Value>(key: string, fallback: Value): Value {
  const inspected = vscode.workspace.getConfiguration('omp').inspect<Value>(`permissions.${key}`);
  return inspected?.globalValue === undefined ? fallback : inspected.globalValue;
}

async function confirmPermissions(mode: PermissionMode, current: PermissionMode): Promise<boolean> {
  if (mode !== 'all' || current === 'all') return true;
  const enabled = await vscode.window.showWarningMessage(
    'Allow commands without confirmation for this connection?',
    {
      modal: true,
      detail:
        'Commands run with your host permissions, without an OS sandbox, and can delete files or send data. Explicit deny rules still block; ask rules and uncertain syntax still prompt. File approvals and tool restrictions stay unchanged. This choice resets on reconnect or session switch.',
    },
    'Enable Allow All',
  );
  return enabled === 'Enable Allow All';
}

export class HostTools {
  private scope: ActiveScope | undefined;
  private closing: Promise<void> | undefined;
  private failed = false;
  private mode: PermissionMode = permissionMode
    .exclude(['all'])
    .parse(permissionSetting('defaultMode', 'rules'));

  constructor(
    private readonly files: Pick<WorkspaceFiles, 'normalize'>,
    private readonly journal: Pick<ReviewJournal, 'read' | 'write'> &
      Partial<Pick<ReviewJournal, 'inspect' | 'delete' | 'move'>>,
    private readonly mutationDirectory?: string,
    private readonly requestApproval: RequestApproval = async () => false,
  ) {}

  begin(scope: ToolScope): void {
    if (this.scope || this.closing || this.failed)
      throw new Error('Previous tool scope has not closed safely.');
    const abort = new AbortController();
    this.scope = { ...scope, abort, signal: AbortSignal.any([scope.signal, abort.signal]) };
  }

  get cleanupFailed(): boolean {
    return this.failed;
  }

  get permissions(): PermissionMode {
    return this.mode;
  }

  resetPermissions(): void {
    this.assertPermissionIdle();
    this.mode = permissionMode.exclude(['all']).parse(permissionSetting('defaultMode', 'rules'));
  }

  async pickPermissions(): Promise<void> {
    this.assertPermissionIdle();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(shield) Ask Every Time', value: 'ask' },
        { label: '$(checklist) Command Rules', value: 'rules' },
        { label: '$(unlock) Allow All Except Restrictions', value: 'all' },
        { label: '$(settings-gear) Edit User Command Rules', value: 'settings' },
      ],
      {
        title: 'OMP Command Permissions',
        placeHolder: `Current mode: ${this.mode}`,
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;
    if (picked.value === 'settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@id:omp.permissions.commandRules',
      );
      return;
    }
    const mode = permissionMode.parse(picked.value);
    if (!(await confirmPermissions(mode, this.mode))) return;
    this.assertPermissionIdle();
    this.mode = mode;
  }

  private assertPermissionIdle(): void {
    if (!vscode.workspace.isTrusted || this.scope || this.closing || this.failed)
      throw new Error(
        'Command permissions cannot change before command cleanup in a trusted workspace.',
      );
  }

  async run<Result>(scope: ToolScope, action: () => Promise<Result>): Promise<Result> {
    this.begin(scope);
    try {
      const active = this.current(scope.sessionId);
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
      return result;
    } finally {
      await this.finish();
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
    const text = await this.journal.read(request.path, scope.signal);
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
    scope.manager ??= new TerminalManager({
      sessionId: scope.sessionId,
      cwd: scope.cwd,
      signal: scope.signal,
      approve: (command, signal) => this.approve(scope, command, signal),
    });
    return scope.manager.create(request);
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
    const provenance: Provenance = { turnId: scope.turnId, toolCallId, tool: 'edit' };
    const target = await checkedPath(
      mutation.path,
      scope.cwd,
      this.mutationDirectory && path.dirname(this.mutationDirectory),
    );
    if (target !== mutation.path) throw new Error('Native mutation path changed after capture.');
    this.assertCurrent(scope);
    if (mutation.op === 'read') {
      if (!this.journal.inspect) throw new Error('Native mutation journal is unavailable.');
      return this.journal.inspect(target, scope.signal);
    }
    if (mutation.op === 'write') {
      const content = await this.files.normalize(target, mutation.content);
      this.assertCurrent(scope);
      if (content.includes('#!')) throw new Error('Executable-bit side effects are disabled.');
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
    await this.applyDestructive(scope, mutation, target, provenance);
    return mutation.op === 'delete' ? '' : mutation.content;
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
        this.mode,
        permissionSetting('commandRules', []),
        permissionSetting('useDefaultRules', true),
      );
    const decision = decide();
    if (decision === 'deny') throw new Error('Command blocked by an OMP user rule.');
    if (decision === 'allow') return true;
    const approved = await this.requestApproval(
      commandApproval(command),
      signal,
      () => this.current(scope.sessionId) === scope,
    );
    signal.throwIfAborted();
    if (this.current(scope.sessionId) !== scope) throw new Error('Terminal approval is stale.');
    if (decide() === 'deny') throw new Error('Command blocked by an OMP user rule.');
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

  finish(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.failed)
      return Promise.reject(new Error('Terminal cleanup failed; tool execution remains disabled.'));
    const scope = this.scope;
    this.scope = undefined;
    scope?.abort.abort();
    this.closing = Promise.all([scope?.manager?.dispose(), scope?.broker?.close()])
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
