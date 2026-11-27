import * as vscode from 'vscode';
import { ChatView, isChatRequest } from './chat-view.js';
import { ContextAttachments, isContextRequest } from './context.js';
import { FollowUps, isQueueRequest, type QueueRequest } from './follow-ups.js';
import { PathGuard, ReviewJournal } from './review.js';
import { webviewMessage, type Attachment, type SavedSession, type StateStore } from './state.js';
import { ReviewEditor, WorkspaceFiles } from './workspace.js';
import { reviewSummary } from './review-presentation.js';
import {
  OMP_TESTED_VERSION,
  ompVersionRequirement,
  parseOmpVersion,
  supportsOmpVersion,
} from './omp-version.js';
import {
  editSession,
  inspectSession,
  isSessionRequest,
  sessionList,
  type SessionRequest,
} from './sessions.js';

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
  disconnect: () => Promise<void>;
  resume: (session: SavedSession) => Promise<void>;
}

export class HostView {
  readonly chat: ChatView;
  readonly attachments = new ContextAttachments();
  readonly followUps = new FollowUps();
  readonly files: WorkspaceFiles;
  readonly journal: ReviewJournal;
  private readonly editor: ReviewEditor;

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
        this.editor.refresh();
        this.chat.publish();
      },
      store.data.changes,
    );
    this.editor = new ReviewEditor(this.files, {
      changes: () => this.journal.list(this.owner()),
      available: actions.available,
      dispatch: (request) => actions.perform(() => this.dispatch(request)),
    });
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
      ...this.editor.register(this.context.extensionUri),
      this.files.imageSnapshots,
      this.files.reviewChanges,
      this.files.reviewRequested,
      vscode.workspace.registerFileSystemProvider('omp-image', this.files.imageSnapshots, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
      vscode.workspace.registerTextDocumentContentProvider('omp-review', {
        onDidChange: this.files.reviewChanges.event,
        provideTextDocumentContent: (uri) => this.files.reviewSnapshots.get(uri.toString()) ?? '',
      }),
      vscode.workspace.onDidChangeTextDocument(refresh),
      vscode.window.onDidChangeActiveTextEditor(() => this.chat.publish()),
      vscode.workspace.onDidChangeConfiguration(() => this.chat.publish()),
      vscode.commands.registerCommand('omp.addFileContext', (uri?: vscode.Uri) => {
        const selected = uri ?? vscode.window.activeTextEditor?.document.uri;
        return this.actions.perform(() => this.addFileContext(selected));
      }),
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

  addSnapshots(snapshots: Attachment[]): Promise<void> {
    return this.actions.idle('context', async () => {
      this.attachments.add(this.owner(), snapshots);
      this.chat.publish();
    });
  }

  contextPresentation() {
    const owner = this.owner();
    const uri = vscode.window.activeTextEditor?.document.uri;
    const enabled = vscode.workspace
      .getConfiguration('omp')
      .get<boolean>('context.activeEditorOffer', true);
    const supported = uri && this.files.acceptsContext(uri);
    const resource =
      enabled && supported && this.actions.available()
        ? { uri: uri.toString(), label: vscode.workspace.asRelativePath(uri, false) }
        : undefined;
    return {
      ...this.attachments.presentation(owner),
      contextOffer: this.attachments.offer(owner, resource),
    };
  }

  private addFileContext(uri?: vscode.Uri): Promise<void> {
    const owner = this.owner();
    return this.actions.idle('context', async () => {
      if (!uri) throw new Error('Choose a file or open an editor to attach context.');
      const snapshot = await this.files.fileContext(uri);
      if (this.owner() !== owner) throw new Error('Context owner changed during capture.');
      this.attachments.add(owner, [snapshot]);
      await vscode.commands.executeCommand('omp.chat.focus');
      this.chat.publish();
    });
  }

  private async contextOffer(request: { type: 'attachOffer' | 'dismissOffer'; id: string }) {
    const owner = this.owner();
    const uri = this.attachments.offeredUri(owner, request.id);
    if (request.type === 'dismissOffer') {
      this.attachments.dismissOffer(owner, request.id);
      this.chat.publish();
      return;
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri)
      throw new Error('The active-editor context offer is stale.');
    await this.addFileContext(vscode.Uri.parse(uri));
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

  assertRoot(root: vscode.WorkspaceFolder): void {
    this.root();
    if (
      !vscode.workspace.workspaceFolders!.some(
        (folder) => folder.uri.toString() === root.uri.toString(),
      )
    )
      throw new Error('The workspace root changed during connection.');
  }

  private savedRoot(session: SavedSession, roots: readonly vscode.WorkspaceFolder[]) {
    const original = roots.find((folder) => folder.uri.toString() === session.root);
    if (!original)
      throw new Error("This session's folder is no longer open. Reopen it or start a new session.");
    return original;
  }

  async switchSession(): Promise<void> {
    await vscode.commands.executeCommand('omp.chat.focus');
    this.chat.post({ v: 1, type: 'showSessions' });
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
    if (!supportsOmpVersion(result.stdout))
      throw new Error(`${ompVersionRequirement()} is required; found ${result.stdout.trim()}.`);
    const version = parseOmpVersion(result.stdout) ?? result.stdout.trim();
    this.output.appendLine(
      `Runtime: ${version}; host: ${vscode.env.remoteName ?? 'local'}; root: ${root.uri.fsPath}`,
    );
    const tested = version === OMP_TESTED_VERSION ? '' : ` (tested with ${OMP_TESTED_VERSION})`;
    await vscode.window.showInformationMessage(
      `OMP ${version} is available on ${vscode.env.remoteName ?? 'the local workspace host'}${tested}.`,
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
    this.editor.refresh();
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

  sessionPresentation() {
    return { sessionIds: this.sessionIds(), sessions: sessionList(this.store.data) };
  }

  private async manageSession(request: SessionRequest) {
    if (!this.actions.available())
      throw new Error('Wait for the current operation before changing sessions.');
    const saved = this.store.data.sessions.find((session) => session.id === request.id);
    if (!saved) throw new Error('The selected session no longer exists.');
    if (request.type === 'resumeSession') {
      if (saved.archivedAt !== undefined)
        throw new Error('Restore this archived session before resuming it.');
      await this.actions.resume(saved);
      return;
    }
    const action = request.type;
    if (action === 'openSession' || (action === 'archiveSession' && this.owner() === request.id))
      await this.actions.disconnect();
    await this.actions.idle('context', async () => {
      if (action === 'openSession') await inspectSession(this.store, request.id);
      else await editSession(this.store, request.id, action, request.title);
      this.chat.publish();
    });
  }

  private validatedRequest(message: unknown) {
    const parsed = webviewMessage.safeParse(message);
    if (!parsed.success) throw new Error('Invalid sidebar message.');
    return parsed.data;
  }

  async dispatch(message: unknown): Promise<void> {
    const request = this.validatedRequest(message);
    if (isSessionRequest(request)) return this.manageSession(request);
    if (request.type === 'attachOffer' || request.type === 'dismissOffer')
      return this.contextOffer({ type: request.type, id: request.id });
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
