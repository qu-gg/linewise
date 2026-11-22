import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import type { CreateTerminalResponse, TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { checkedReadPath } from './file-policy.js';
import { PathGuard } from './path-guard.js';
import { taskCommand, taskRequest, taskShellCommand } from './task-policy.js';
import type { TaskRequest } from './task-policy.js';
import type { TerminalManager } from './terminal.js';
import { taskGraphLayers, runCapturedTaskGraph } from './task-graph.js';
import type { TaskGraphNode, TaskGraphExecution } from './task-graph.js';
import { awaitTaskOperation as cancellable, runOwnedTaskProcess } from './task-readiness.js';
import { taskDiagnosticRows, taskDiagnosticOffset } from './task-diagnostics.js';
import type { TaskDiagnostic } from './task-diagnostics.js';

const taskProblems = new WeakMap<AbortSignal, vscode.DiagnosticCollection>();

interface CaptureScope {
  cwd: string;
  privateRoot?: string;
  signal: AbortSignal;
  valid(): boolean;
}

interface Scope extends CaptureScope {
  sessionId: string;
}

function current(scope: CaptureScope): void {
  scope.signal.throwIfAborted();
  if (!scope.valid()) throw new Error('Task belongs to a retired prompt.');
}

async function taskDiagnosticFile(row: TaskDiagnostic, scope: Scope) {
  const file = await checkedReadPath(row.path, scope.cwd, scope.privateRoot);
  if (!(await new PathGuard([scope.cwd]).resolve(file)).inside)
    throw new Error('Task diagnostic is outside its root.');
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 1048576)
    throw new Error('Task diagnostic source is unavailable.');
  const uri = vscode.Uri.file(file);
  const document = await cancellable(vscode.workspace.openTextDocument(uri), scope.signal);
  const version = document.version;
  const position = document.positionAt(taskDiagnosticOffset(document.getText(), row));
  if (
    (await checkedReadPath(row.path, scope.cwd, scope.privateRoot)) !== file ||
    document.version !== version
  )
    throw new Error('Task diagnostic source changed.');
  current(scope);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(position, position),
    row.message,
    row.severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = 'OMP Task';
  return { uri, diagnostic, row: { ...row, path: path.relative(scope.cwd, file) } };
}

async function publishTaskDiagnostics(
  outputs: readonly Partial<TerminalOutputResponse>[],
  scope: Scope,
) {
  const parsed = taskDiagnosticRows(outputs);
  const items = [];
  const files = new Map<string, [vscode.Uri, vscode.Diagnostic[]]>();
  for (const row of parsed.items) {
    try {
      const item = await taskDiagnosticFile(row, scope);
      const entry =
        files.get(item.uri.toString()) ?? ([item.uri, []] as [vscode.Uri, vscode.Diagnostic[]]);
      entry[1].push(item.diagnostic);
      files.set(item.uri.toString(), entry);
      items.push(item.row);
    } catch {
      current(scope);
      parsed.ignored++;
    }
  }
  current(scope);
  let collection = taskProblems.get(scope.signal);
  if (items.length && !collection) {
    collection = vscode.languages.createDiagnosticCollection('OMP Tasks');
    taskProblems.set(scope.signal, collection);
    scope.signal.addEventListener(
      'abort',
      () => {
        collection!.dispose();
        taskProblems.delete(scope.signal);
      },
      { once: true },
    );
  }
  collection?.clear();
  collection?.set([...files.values()]);
  return { ...parsed, items };
}

function taskRoot(task: vscode.Task): vscode.Uri | undefined {
  if (task.scope !== vscode.TaskScope.Workspace)
    return typeof task.scope === 'object' ? task.scope?.uri : undefined;
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1 ? folders[0]!.uri : undefined;
}

async function workspaceTask(task: vscode.Task, scope: CaptureScope): Promise<boolean> {
  const uri = taskRoot(task);
  if (uri?.scheme !== 'file') return false;
  try {
    const root = await checkedReadPath(uri.fsPath, scope.cwd, scope.privateRoot);
    return root === (await new PathGuard([scope.cwd]).resolve(scope.cwd)).path;
  } catch {
    current(scope);
    return false;
  }
}

function concreteCommand(execution: vscode.Task['execution'], cwd: string) {
  if (!(execution instanceof vscode.ProcessExecution || execution instanceof vscode.ShellExecution))
    throw new Error('Opaque/custom task execution is not forwarded.');
  return taskCommand.parse({
    ...(execution instanceof vscode.ProcessExecution
      ? { command: execution.process, args: execution.args }
      : taskShellCommand(execution)),
    cwd: execution.options?.cwd ?? cwd,
    env: execution.options?.env ?? {},
  });
}

async function capture(
  task: vscode.Task,
  scope: CaptureScope,
  readiness?: TaskGraphNode['readiness'],
) {
  if (!(await workspaceTask(task, scope)) || !!task.isBackground !== !!readiness)
    throw new Error(
      'Only foreground workspace tasks or declared background graph prerequisites are supported.',
    );
  const command = concreteCommand(task.execution, scope.cwd);
  const cwd = await checkedReadPath(
    path.resolve(scope.cwd, command.cwd),
    scope.cwd,
    scope.privateRoot,
  );
  if (!(await new PathGuard([scope.cwd]).resolve(cwd)).inside)
    throw new Error('Task cwd must be inside the workspace.');
  current(scope);
  return {
    ...command,
    cwd,
    env: Object.entries(command.env).map(([name, value]) => ({ name, value })),
  };
}

async function discoveredTasks(scope: CaptureScope): Promise<vscode.Task[]> {
  const candidates = await cancellable(vscode.tasks.fetchTasks(), scope.signal);
  current(scope);
  if (!Array.isArray(candidates)) throw new Error('Task provider returned malformed discovery.');
  if (candidates.length > 1000) throw new Error('Task discovery exceeds 1000 candidates.');
  return candidates;
}

async function taskMetadata(task: vscode.Task, scope: CaptureScope, ambiguous: boolean) {
  const execution = task.execution;
  const kind =
    execution instanceof vscode.ProcessExecution
      ? 'process'
      : execution instanceof vscode.ShellExecution
        ? 'shell'
        : 'custom-or-unavailable';
  let unavailableReason: string | undefined;
  if (ambiguous) unavailableReason = 'ambiguous-identity';
  else if (kind === 'custom-or-unavailable') unavailableReason = 'opaque-execution';
  else {
    try {
      await capture(
        task,
        scope,
        task.isBackground ? { line: 'declared-readiness-required' } : undefined,
      );
      if (task.isBackground) unavailableReason = 'background-readiness-required';
    } catch {
      current(scope);
      unavailableReason = 'concrete-command-unavailable';
    }
  }
  return {
    name: task.name,
    source: task.source,
    root: '.',
    type: String(task.definition?.type).slice(0, 200),
    execution: kind,
    supported: unavailableReason === undefined,
    graphSupported:
      unavailableReason === undefined || unavailableReason === 'background-readiness-required',
    unavailableReason,
    readOnly: true,
  };
}

export async function workspaceTaskMetadata(
  scope: Omit<CaptureScope, 'valid'>,
  limit: number,
): Promise<object[]> {
  const currentScope = { ...scope, valid: () => !scope.signal.aborted };
  const candidates = await discoveredTasks(currentScope);
  const selected: vscode.Task[] = [];
  const identities = new Map<string, number>();
  for (const task of candidates) {
    if (!task || typeof task !== 'object') throw new Error('Malformed task metadata.');
    if (!taskRequest.safeParse({ name: task.name, source: task.source }).success)
      throw new Error('Malformed task identity.');
    if (!(await workspaceTask(task, currentScope))) continue;
    selected.push(task);
    const identity = JSON.stringify([task.source, task.name]);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  const result: object[] = [];
  for (const task of selected.slice(0, limit + 1)) {
    const ambiguous = identities.get(JSON.stringify([task.source, task.name]))! > 1;
    result.push(await taskMetadata(task, currentScope, ambiguous));
  }
  current(currentScope);
  return result;
}

async function selectTask(
  input: Pick<TaskRequest, 'name' | 'source'>,
  scope: Scope,
  candidates: vscode.Task[],
) {
  const matches = [];
  for (const candidate of candidates)
    if (
      candidate.name === input.name &&
      candidate.source === input.source &&
      (await workspaceTask(candidate, scope))
    )
      matches.push(candidate);
  if (matches.length !== 1)
    throw new Error('Task is unavailable or ambiguous; inspect editor tasks first.');
  return matches[0]!;
}

async function select(input: TaskRequest, scope: Scope) {
  return capture(await selectTask(input, scope, await discoveredTasks(scope)), scope);
}

type Command = Awaited<ReturnType<typeof capture>>;

class TaskTerminal implements vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writes.event;
  readonly onDidClose = this.closed.event;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private claimed = false;
  finished = false;
  private resolve!: (value: TerminalOutputResponse) => void;
  private reject!: (error: unknown) => void;
  private running: Promise<TerminalOutputResponse> | undefined;
  private resolveReady!: (value: TerminalOutputResponse) => void;
  private rejectReady!: (error: unknown) => void;
  readonly ready = new Promise<TerminalOutputResponse>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  readonly done = new Promise<TerminalOutputResponse>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(
    private readonly manager: TerminalManager,
    private readonly scope: Scope,
    private readonly command: Command,
    private readonly timeout: number | null,
    private readonly reservation?: {
      start(): Promise<CreateTerminalResponse>;
      signal: AbortSignal;
      readiness?: TaskGraphNode['readiness'];
    },
  ) {
    this.signal = AbortSignal.any([
      scope.signal,
      this.abort.signal,
      reservation?.signal ?? scope.signal,
    ]);
    void this.done.catch(() => {});
    void this.ready.catch(() => {});
  }

  claim(): vscode.Pseudoterminal {
    current(this.scope);
    this.signal.throwIfAborted();
    if (this.claimed) throw new Error('Task execution has already been claimed.');
    this.claimed = true;
    return this;
  }

  open(): void {
    if (this.running || this.signal.aborted) {
      this.reject(new Error('Task is cancelled or already started.'));
      return;
    }
    this.running = this.run();
    void this.running.then(
      (result) => {
        const output = stripVTControlCharacters(result.output).replace(/\p{Cc}/gu, (value) =>
          ['\r', '\n', '\t'].includes(value) ? value : '',
        );
        this.writes.fire(output.replace(/\r?\n/g, '\r\n'));
        this.finished = true;
        this.closed.fire(result.exitStatus?.exitCode ?? 1);
        this.resolve(result);
      },
      (error: unknown) => {
        this.finished = true;
        this.closed.fire(1);
        this.rejectReady(error);
        this.reject(error);
      },
    );
  }

  close(): void {
    this.abort.abort(new Error('Native task was cancelled.'));
    if (!this.running) {
      this.rejectReady(this.signal.reason);
      this.reject(this.signal.reason);
    }
  }

  private async run(): Promise<TerminalOutputResponse> {
    return runOwnedTaskProcess(
      this.manager,
      { sessionId: this.scope.sessionId, ...this.command, outputByteLimit: 65536 },
      this.timeout,
      { signal: this.signal, ownerSignal: this.scope.signal, check: () => current(this.scope) },
      this.reservation,
      this.resolveReady,
    );
  }

  async dispose(): Promise<void> {
    this.close();
    await this.running?.catch(() => {});
    this.writes.dispose();
    this.closed.dispose();
  }
}

function preserveDirtyTaskBuffers(root: vscode.Uri): void {
  const mode = vscode.workspace
    .getConfiguration('task', root)
    .get<string>('saveBeforeRun', 'always');
  if (mode === 'never') return;
  const documents = [...vscode.workspace.textDocuments, ...vscode.workspace.notebookDocuments];
  if (documents.some((document) => document.isDirty))
    throw new Error(
      'Task execution could save dirty text or notebook buffers. Save them yourself or set task.saveBeforeRun to never.',
    );
}

async function ownedTask(
  name: string,
  scope: Scope,
  manager: TerminalManager,
  command: Command,
  timeout: number | null,
  reservation?: {
    start(): Promise<CreateTerminalResponse>;
    signal: AbortSignal;
    readiness?: TaskGraphNode['readiness'];
  },
): Promise<TaskGraphExecution> {
  current(scope);
  const signal = AbortSignal.any([scope.signal, reservation?.signal ?? scope.signal]);
  signal.throwIfAborted();
  const folder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.fsPath === scope.cwd);
  if (!folder) throw new Error('Task workspace root is unavailable.');
  preserveDirtyTaskBuffers(folder.uri);
  const terminal = new TaskTerminal(manager, scope, command, timeout, reservation);
  let execution: vscode.TaskExecution | undefined;
  let retained = false;
  const dispose = async () => {
    await terminal.dispose();
    if (!terminal.finished) execution?.terminate();
  };
  try {
    const task = new vscode.Task(
      { type: 'omp-owned-task', id: randomUUID() },
      folder,
      name,
      'OMP',
      new vscode.CustomExecution(async () => terminal.claim()),
      [],
    );
    task.isBackground = !!reservation?.readiness;
    const starting = vscode.tasks.executeTask(task);
    void starting.then(
      (started) => {
        execution = started;
        if (signal.aborted && !terminal.finished) started.terminate();
      },
      () => {},
    );
    await cancellable(starting, signal);
    if (reservation?.readiness) {
      const snapshot = await cancellable(terminal.ready, signal);
      current(scope);
      signal.throwIfAborted();
      retained = true;
      return { snapshot, completion: terminal.done, dispose };
    }
    const result = await cancellable(terminal.done, signal);
    current(scope);
    return result;
  } finally {
    if (!retained) await dispose();
  }
}

async function captureGraph(nodes: TaskGraphNode[], scope: Scope) {
  const candidates = await discoveredTasks(scope);
  const captured = [];
  for (const node of nodes) {
    const task = await selectTask(node, scope, candidates);
    const definition = JSON.stringify(structuredClone(task.definition));
    if (Buffer.byteLength(definition) > 65536) throw new Error('Task definition is too large.');
    captured.push({ node, definition, command: await capture(task, scope, node.readiness) });
  }
  current(scope);
  return captured;
}

async function executeGraph(input: TaskRequest, scope: Scope, manager: TerminalManager) {
  const nodes = taskGraphLayers(input).flat();
  const captured = await captureGraph(nodes, scope);
  const folder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.fsPath === scope.cwd);
  if (!folder) throw new Error('Task workspace root is unavailable.');
  preserveDirtyTaskBuffers(folder.uri);
  const result = await runCapturedTaskGraph(
    input,
    captured,
    manager,
    scope,
    (signal) => captureGraph(nodes, { ...scope, signal }),
    (entry, reservation) =>
      ownedTask(
        entry.node.name,
        scope,
        manager,
        entry.command,
        input.timeout ? input.timeout * 1000 : null,
        { ...reservation, readiness: entry.node.readiness },
      ),
  );
  return {
    task: { name: input.name, source: input.source },
    graph: 'OMP-owned',
    ...result,
    diagnostics: await publishTaskDiagnostics(result.results, scope),
    untrusted: true,
  };
}

export async function executeWorkspaceTask(
  input: TaskRequest,
  scope: Scope,
  manager: TerminalManager,
): Promise<string> {
  current(scope);
  if (input.graph) return JSON.stringify(await executeGraph(input, scope, manager));
  const command = await select(input, scope);
  const result = await ownedTask(
    input.name,
    scope,
    manager,
    command,
    input.timeout ? input.timeout * 1000 : null,
  );
  if ('completion' in result) throw new Error('Standalone background tasks are unavailable.');
  return JSON.stringify({
    task: { name: input.name, source: input.source },
    ...result,
    diagnostics: await publishTaskDiagnostics([result], scope),
    untrusted: true,
  });
}
