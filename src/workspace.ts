import * as vscode from 'vscode';
import type { TextFiles } from './review.js';
import { contextSnapshot } from './context.js';
import type { Attachment } from './state.js';
import type { Change } from './review-types.js';
import { editedProposal } from './review-types.js';
import { reviewImages } from './review-presentation.js';
import { reviewHunks } from './review-hunks.js';
import path from 'node:path';
import { ImageSnapshots, pickImageContext, pickedImage } from './host-image-context.js';
import { InlineReviewView, type EditorReviewHost } from './inline-review-view.js';

export class ReviewEditor implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private available = false;
  private inline?: InlineReviewView;

  constructor(
    private readonly files: WorkspaceFiles,
    private readonly host: EditorReviewHost,
  ) {}

  register(extensionUri: vscode.Uri): vscode.Disposable[] {
    this.inline = new InlineReviewView(extensionUri, this.files, this.host, () => this.refresh());
    return [
      this,
      ...this.inline.register(),
      vscode.languages.registerCodeLensProvider({ scheme: 'omp-review' }, this),
      vscode.commands.registerCommand('omp.reviewHunk', (request: unknown) =>
        this.host.dispatch(request),
      ),
      ...(['Previous', 'Next', 'Keep', 'Discard'] as const).map((action) =>
        vscode.commands.registerCommand(`omp.review${action}`, () => this.atCursor(action)),
      ),
    ];
  }

  private current(document: vscode.TextDocument) {
    if (!this.host.available() || document.uri.scheme !== 'omp-review') return;
    return this.host
      .changes()
      .find(
        (item) =>
          document.uri.path === reviewImages(item)[1]!.path &&
          this.files.reviewSnapshots.has(document.uri.toString()),
      );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const change = this.current(document);
    if (!change || change.state !== 'pending' || editedProposal(change)) return [];
    return reviewHunks(change).flatMap((hunk) => {
      const line = Math.min(Math.max(0, hunk.newStart - 1), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      return (['Keep', 'Discard'] as const).map((title) => ({
        range,
        isResolved: true,
        command: {
          title: `${title} Change`,
          command: 'omp.reviewHunk',
          arguments: [
            {
              v: 1,
              type: title === 'Keep' ? 'hunkKeep' : 'hunkDiscard',
              id: change.id,
              hunkId: hunk.id,
            },
          ],
        },
      }));
    });
  }

  async atCursor(action: 'Previous' | 'Next' | 'Keep' | 'Discard'): Promise<void> {
    if (await this.inline?.atCursor(action)) return;
    await this.nativeCursor(action);
  }

  private async nativeCursor(action: 'Previous' | 'Next' | 'Keep' | 'Discard'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const change = editor && this.current(editor.document);
    const hunks = change?.state === 'pending' ? reviewHunks(change) : [];
    if (!editor || !change || !hunks.length)
      throw new Error('Select an idle, current OMP change to review.');
    const index = hunks.reduce(
      (selected, hunk, position) =>
        hunk.newStart <= editor.selection.active.line + 1 ? position : selected,
      0,
    );
    if (['Previous', 'Next'].includes(action)) {
      const direction = action === 'Previous' ? -1 : 1;
      const hunk = hunks[(index + direction + hunks.length) % hunks.length]!;
      await this.files.review(change, hunk.id);
    } else {
      await this.host.dispatch({
        v: 1,
        type: action === 'Keep' ? 'hunkKeep' : 'hunkDiscard',
        id: change.id,
        hunkId: hunks[index]!.id,
      });
    }
  }

  refresh(): void {
    this.inline?.refresh();
    for (const change of this.host.changes()) {
      const uri = vscode.Uri.from({ scheme: 'omp-review', path: reviewImages(change)[1]!.path });
      if (this.files.reviewSnapshots.has(uri.toString())) this.files.updateReview(change);
    }
    const available = Boolean(this.inline?.available || this.lensAvailable());
    if (available !== this.available) {
      this.available = available;
      void vscode.commands.executeCommand('setContext', 'omp.reviewAvailable', available);
    }
    this.changed.fire();
  }

  private lensAvailable(): boolean {
    const document = vscode.window.activeTextEditor?.document;
    const active = document && this.current(document);
    return Boolean(
      active?.state === 'pending' && !editedProposal(active) && reviewHunks(active).length,
    );
  }

  dispose(): void {
    this.inline?.dispose();
    this.changed.dispose();
  }
}

export class WorkspaceFiles implements TextFiles {
  readonly reviewSnapshots = new Map<string, string>();
  readonly reviewSelections = new Map<string, string | undefined>();
  readonly reviewRequested = new vscode.EventEmitter<{ uri: vscode.Uri; hunkId?: string }>();
  readonly reviewChanges = new vscode.EventEmitter<vscode.Uri>();
  readonly imageSnapshots = new ImageSnapshots();
  constructor(private readonly host: vscode.Uri) {}

  updateReview(change: Change): vscode.Uri[] {
    return reviewImages(change).map((image) => {
      const uri = vscode.Uri.from({ scheme: 'omp-review', path: image.path });
      const key = uri.toString();
      const previous = this.reviewSnapshots.get(key);
      this.reviewSnapshots.set(key, image.text);
      if (previous !== undefined && previous !== image.text) this.reviewChanges.fire(uri);
      return uri;
    });
  }

  async review(change: Change, hunkId?: string): Promise<void> {
    const hunk = reviewHunks(change).find((candidate) => candidate.id === hunkId);
    if (hunkId && !hunk) throw new Error('Review hunk is stale or no longer available.');
    const images = this.updateReview(change);
    this.reviewSelections.set(images[1]!.toString(), hunkId);
    this.reviewRequested.fire({ uri: images[1]!, hunkId });
    await vscode.commands.executeCommand('vscode.openWith', images[1]!, 'omp.inlineReview', {
      preview: true,
    });
  }

  editorContext(): Attachment {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('No active editor to attach.');
    const selected = !editor.selection.isEmpty;
    const label = `${path.basename(editor.document.uri.path)}${selected ? `:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}` : ''}`;
    return contextSnapshot(
      selected ? 'selection' : 'file',
      label,
      editor.document.uri.toString(),
      `Editor attachment: ${editor.document.uri.toString()}\n${editor.document.getText(selected ? editor.selection : undefined)}`,
    );
  }

  async pickContext(): Promise<Attachment[]> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(selection) Active Editor or Selection', value: 'editor' },
        { label: '$(files) Files...', value: 'files' },
        { label: '$(file-media) Images...', value: 'images' },
        { label: '$(file-text) Open Text Resources...', value: 'resources' },
        { label: '$(warning) Workspace Problems', value: 'diagnostics' },
      ],
      { title: 'Add Context', ignoreFocusOut: true },
    );
    if (!picked) return [];
    if (picked.value === 'editor') return [this.editorContext()];
    if (picked.value === 'diagnostics') return [this.diagnosticsContext()];
    if (picked.value === 'resources') return this.resourceContexts();
    if (picked.value === 'images') return pickImageContext(this.host);
    return this.fileContexts();
  }

  private async fileContexts(): Promise<Attachment[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: 'Attach',
    });
    const snapshots: Attachment[] = [];
    for (const uri of uris ?? []) snapshots.push(await this.fileContext(uri));
    return snapshots;
  }

  acceptsContext(uri: vscode.Uri): boolean {
    return (
      uri.scheme === 'untitled' ||
      (uri.scheme === this.host.scheme && uri.authority === this.host.authority)
    );
  }

  async fileContext(uri: vscode.Uri): Promise<Attachment> {
    if (uri.scheme === 'untitled') {
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.toString() === uri.toString(),
      );
      if (!document) throw new Error('The selected unsaved resource is no longer open.');
      return contextSnapshot(
        'resource',
        path.basename(uri.path),
        uri.toString(),
        document.getText(),
      );
    }
    if (!this.acceptsContext(uri)) throw new Error('Choose a file on the active workspace host.');
    if (/\.(png|jpe?g|webp)$/i.test(uri.path))
      return (await pickedImage(this.host, uri, 1_048_576)).snapshot;
    const text = await this.read(uri.fsPath);
    if (text === null) throw new Error('The selected file no longer exists.');
    return contextSnapshot('file', path.basename(uri.path), uri.toString(), text);
  }

  private async resourceContexts(): Promise<Attachment[]> {
    const resources = vscode.workspace.textDocuments.filter((document) =>
      this.acceptsContext(document.uri),
    );
    const selected = await vscode.window.showQuickPick(
      resources.map((document) => ({
        label: path.basename(document.uri.path),
        description: document.uri.toString(),
        document,
      })),
      { title: 'Attach Text Resources', canPickMany: true, ignoreFocusOut: true },
    );
    return (selected ?? []).map(({ document }) =>
      contextSnapshot(
        'resource',
        path.basename(document.uri.path),
        document.uri.toString(),
        document.getText(),
      ),
    );
  }

  private diagnosticsContext(): Attachment {
    const diagnostics = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => vscode.workspace.getWorkspaceFolder(uri));
    const entries = diagnostics.flatMap(([uri, items]) =>
      items.map(
        (item) =>
          `${uri.toString()}:${item.range.start.line + 1}:${item.range.start.character + 1}: ${vscode.DiagnosticSeverity[item.severity]}: ${item.message}`,
      ),
    );
    const text = `${entries.length} workspace diagnostics; first ${Math.min(entries.length, 200)} included.\n${entries.slice(0, 200).join('\n')}`;
    return contextSnapshot(
      'diagnostics',
      `Problems (${Math.min(entries.length, 200)}/${entries.length})`,
      this.host.toString(),
      text,
    );
  }

  async inspectContext(attachment: Attachment): Promise<void> {
    if (attachment.image) {
      await vscode.commands.executeCommand(
        'vscode.open',
        this.imageSnapshots.capture(attachment.image),
        { preview: true },
      );
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      content: attachment.text,
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  uri(target: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: this.host.scheme,
      authority: this.host.authority,
      path: target,
    });
  }

  async normalize(target: string, content: string): Promise<string> {
    const previous = await this.read(target);
    return content.replace(/\r?\n/g, previous?.includes('\r\n') ? '\r\n' : '\n');
  }

  isDirty(target: string): boolean {
    const uri = this.uri(target);
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === uri.toString() && document.isDirty,
    );
  }

  async read(target: string): Promise<string | null> {
    const uri = this.uri(target);
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    try {
      const text = await this.diskText(uri);
      return this.bufferedText(target, text, document);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound')
        return document?.isDirty ? document.getText() : null;
      throw error;
    }
  }

  async replace(target: string, expected: string | null, content: string | null): Promise<void> {
    const uri = this.uri(target);
    this.assertNotebookClean(uri);
    if ((await this.read(target)) !== expected)
      throw new Error('File or editor buffer changed before the operation could be applied.');
    const edit = await this.replacement(uri, expected, content);
    this.assertNotebookClean(uri);
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error('VS Code rejected the file operation.');
    if (content !== null) {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!(await document.save()))
        throw new Error(
          'VS Code could not save the changed buffer. Pending review has been preserved.',
        );
    }
  }

  async preflightDelete(target: string): Promise<void> {
    const uri = this.uri(target);
    this.assertNotebookClean(uri);
    if (
      vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === uri.toString() && document.isDirty,
      )
    )
      throw new Error('Save or close the dirty buffer before deleting or moving this file.');
    await this.diskText(uri);
  }

  async move(
    source: string,
    destination: string,
    expected: string,
    content: string,
  ): Promise<void> {
    await this.preflightDelete(source);
    if ((await this.read(source)) !== expected || (await this.read(destination)) !== null)
      throw new Error('Move source or destination changed before the operation.');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(this.uri(source), this.uri(destination), {
      overwrite: false,
      ignoreIfExists: false,
    });
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error('VS Code rejected the file operation.');
    if (expected !== content) await this.replace(destination, expected, content);
  }

  private assertNotebookClean(uri: vscode.Uri): void {
    if (
      vscode.workspace.notebookDocuments.some(
        (document) => document.uri.toString() === uri.toString() && document.isDirty,
      )
    )
      throw new Error('Save or close the dirty notebook before changing its serialized file.');
  }

  private bufferedText(target: string, text: string, document?: vscode.TextDocument): string {
    if (target.endsWith('.ipynb') && !document?.isDirty) return text;
    return document?.getText() ?? text;
  }

  private async diskText(uri: vscode.Uri): Promise<string> {
    const metadata = await vscode.workspace.fs.stat(uri);
    if (metadata.type !== vscode.FileType.File || metadata.size > 1024 * 1024)
      throw new Error('Only regular text files up to 1 MiB are supported.');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      throw new Error('UTF-8 BOM files are not supported by this feasibility build.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Binary files are not supported.');
    return text;
  }

  private async replacement(
    uri: vscode.Uri,
    expected: string | null,
    content: string | null,
  ): Promise<vscode.WorkspaceEdit> {
    const edit = new vscode.WorkspaceEdit();
    if (content === null) {
      await this.preflightDelete(uri.path);
      edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
    } else {
      const encoding = vscode.workspace
        .getConfiguration('files', uri)
        .get<string>('encoding', 'utf8');
      if (encoding !== 'utf8')
        throw new Error('This feasibility build only writes UTF-8 files without a BOM.');
      if (expected === null) edit.createFile(uri, { overwrite: false });
      const document = expected === null ? undefined : await vscode.workspace.openTextDocument(uri);
      if (document && document.getText() !== expected)
        throw new Error('Text buffer changed before preparing the file operation.');
      const end = document?.positionAt(document.getText().length) ?? new vscode.Position(0, 0);
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
    }
    return edit;
  }
}
