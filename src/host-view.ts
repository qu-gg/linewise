import * as vscode from 'vscode';
import { ChatView, isChatRequest } from './chat-view.js';
import { ContextAttachments, isContextRequest } from './context.js';
import { FollowUps, isQueueRequest, type QueueRequest } from './follow-ups.js';
import { PathGuard, ReviewJournal } from './review.js';
import { webviewMessage, type SavedSession, type StateStore } from './state.js';
import { WorkspaceFiles } from './workspace.js';
import { reviewSummary } from './review-presentation.js';

export type SidebarRequest = ReturnType<typeof webviewMessage.parse>;
interface ViewActions {
  snapshot: () => unknown;
  dispatch: (request: SidebarRequest) => Promise<void>;
  perform: (action: () => Promise<void>) => Promise<void>;
  fileOwner: () => () => boolean;
  idle: (kind: 'context' | 'review', action: () => Promise<void>) => Promise<void>;
  busy: () => boolean;
  available: () => boolean;
  drain: () => Promise<void>;
}

export class HostView {
  readonly chat: ChatView;
  readonly attachments = new ContextAttachments();
  readonly followUps = new FollowUps();
  readonly files: WorkspaceFiles;
  readonly journal: ReviewJournal;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly output: vscode.OutputChannel,
    private readonly actions: ViewActions,
  ) {
    this.chat = new ChatView(
      context,
      output,
      actions.snapshot,
      (message) => actions.perform(() => this.dispatch(message)),
      actions.fileOwner,
    );
    this.files = new WorkspaceFiles(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/'),
    );
    const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    this.journal = new ReviewJournal(
      this.files,
      new PathGuard(roots),
      (operation, signal) => this.chat.requestFile(operation, signal),
      async (changes) => {
        this.store.data.changes = [...changes];
        await this.store.save();
        this.chat.publish();
      },
      store.data.changes,
    );
  }

  async initialize(): Promise<void> {
    await this.journal.refresh();
    const refresh = () => {
      void this.actions.perform(async () => {
        await this.journal.refresh();
        this.chat.publish();
      });
    };
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('omp-review', {
        provideTextDocumentContent: (uri) => this.files.reviewSnapshots.get(uri.toString()) ?? '',
      }),
      vscode.workspace.onDidChangeTextDocument(refresh),
    );
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*'),
      );
      this.context.subscriptions.push(
        watcher,
        watcher.onDidChange(refresh),
        watcher.onDidCreate(refresh),
        watcher.onDidDelete(refresh),
      );
    }
  }

  root(session?: SavedSession): vscode.WorkspaceFolder {
    const roots = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running OMP.');
    if (!roots?.length) throw new Error('Open a workspace folder to start OMP.');
    if (
      roots.some(
        (folder) =>
          !['file', 'vscode-remote'].includes(folder.uri.scheme) ||
          folder.uri.authority !== roots[0]!.uri.authority,
      )
    )
      throw new Error("Only filesystem roots on this window's workspace host are supported.");
    if (session) return this.savedRoot(session, roots);
    return (
      (vscode.window.activeTextEditor &&
        vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)) ||
      roots[0]!
    );
  }

  private savedRoot(session: SavedSession, roots: readonly vscode.WorkspaceFolder[]) {
    const original = roots.find((folder) => folder.uri.toString() === session.root);
    if (!original)
      throw new Error("This session's folder is no longer open. Reopen it or start a new session.");
    return original;
  }

  async preflight(
    executable: string,
    run: (
      command: string,
      args: string[],
      options: { cwd: string; timeout: number; maxBuffer: number },
    ) => Promise<{ stdout: string }>,
  ) {
    const root = this.root();
    const result = await run(executable, ['--version'], {
      cwd: root.uri.fsPath,
      timeout: 15_000,
      maxBuffer: 65536,
    });
    if (!result.stdout.includes('18.21.0'))
      throw new Error(`OMP 18.21.0 is required; found ${result.stdout.trim()}.`);
    this.output.appendLine(
      `Runtime: ${result.stdout.trim()}; host: ${vscode.env.remoteName ?? 'local'}; root: ${root.uri.fsPath}`,
    );
    await vscode.window.showInformationMessage(
      `OMP 18.21.0 is available on ${vscode.env.remoteName ?? 'the local workspace host'}.`,
    );
  }

  async editPrompt(id: string, branch: () => Promise<void>) {
    try {
      await branch();
      this.chat.post({ v: 1, type: 'editResult', id, ok: true });
    } catch (error) {
      const retained =
        this.active()?.turns.find((current) => current.id === id) ?? this.active()?.turns.at(-1);
      this.chat.post({ v: 1, type: 'editResult', id, ok: false, turnId: retained?.id });
      throw error;
    }
  }

  async maintain(action: () => Promise<void>) {
    const before = this.store.data.sessions.map((session) => session.id);
    try {
      await action();
    } finally {
      const retained = new Set(this.store.data.sessions.map((session) => session.id));
      const removed = before.filter((id) => !retained.has(id));
      for (const id of removed) this.attachments.clear(id);
    }
  }

  active() {
    return this.store.data.sessions.find(
      (session) => session.id === this.store.data.activeSessionId,
    );
  }
  owner() {
    return this.active()?.id ?? 'new';
  }

  changes() {
    return this.journal
      .list(this.store.data.activeSessionId)
      .map((change) =>
        reviewSummary(
          change,
          (target) => vscode.workspace.asRelativePath(this.files.uri(target), false),
          this.active()?.turns,
        ),
      );
  }

  sessionIds() {
    return this.store.data.sessions.map((session) => session.id);
  }

  async dispatch(message: unknown): Promise<void> {
    const parsed = webviewMessage.safeParse(message);
    if (!parsed.success) throw new Error('Invalid sidebar message.');
    const request = parsed.data;
    if ('hunkId' in request) return this.hunkAction(request);
    if (isQueueRequest(request)) return this.queue(request);
    if (isContextRequest(request))
      return this.actions.idle('context', () =>
        this.attachments.handle(this.owner(), request, this.files),
      );
    if (isChatRequest(request)) return void (await this.chat.localAction(request));
    if (['review', 'keep', 'discard', 'keepAll', 'discardAll'].includes(request.type))
      return this.review(request);
    if (['openFolder', 'copyTool', 'link'].includes(request.type)) return this.utility(request);
    return this.actions.dispatch(request);
  }

  private async queue(request: QueueRequest) {
    try {
      await this.followUps.handle(this.owner(), request, {
        busy: this.actions.busy(),
        idle: this.actions.available(),
        capture: () => this.attachments.capture(this.owner()),
        clearAttachments: () => this.attachments.clear(this.owner()),
        drain: this.actions.drain,
      });
    } finally {
      this.chat.publish();
    }
  }

  private change(id: string) {
    const change = this.journal
      .list(this.store.data.activeSessionId)
      .find((candidate) => candidate.id === id);
    if (!change) throw new Error('This change does not belong to the active session.');
    return change;
  }

  private async review(request: SidebarRequest) {
    if (request.type === 'review') return this.files.review(this.change(request.id));
    await this.actions.idle('review', async () => {
      if (request.type === 'keep' || request.type === 'discard') {
        this.change(request.id);
        if (request.type === 'keep') await this.journal.keep(request.id);
        else await this.journal.discard(request.id);
        return;
      }
      const session = this.active();
      if (!session) throw new Error('Select a session before resolving its changes.');
      for (const change of this.journal.list(session.id)) {
        if (request.type === 'keepAll') await this.journal.keep(change.id);
        else await this.journal.discard(change.id);
      }
    });
  }

  private async hunkAction(request: {
    type: 'hunkReview' | 'hunkKeep' | 'hunkDiscard';
    id: string;
    hunkId: string;
  }) {
    if (request.type === 'hunkReview')
      return this.files.review(this.change(request.id), request.hunkId);
    await this.actions.idle('review', async () => {
      this.change(request.id);
      await this.journal.resolveHunk(
        request.id,
        request.hunkId,
        request.type === 'hunkKeep' ? 'keep' : 'discard',
      );
    });
  }

  private async utility(request: SidebarRequest) {
    if (request.type === 'openFolder') {
      await vscode.commands.executeCommand('vscode.openFolder');
      return;
    }
    if (request.type === 'copyTool') return this.copyTool(request.id);
    if (request.type === 'link') {
      const uri = vscode.Uri.parse(request.href);
      if (!['https', 'http', 'mailto'].includes(uri.scheme))
        throw new Error('Only explicit web or email links are supported here.');
      await vscode.env.openExternal(uri);
    }
  }

  private async copyTool(id: string) {
    const block = this.active()
      ?.turns.flatMap((current) => current.blocks)
      .find((candidate) => candidate.id === id && candidate.kind === 'tool');
    if (!block) throw new Error('Tool output is no longer available.');
    await vscode.env.clipboard.writeText(
      block.command ? `${block.command}\n${block.text}` : block.text,
    );
  }
}
