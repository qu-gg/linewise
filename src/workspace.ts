import * as vscode from 'vscode';
import type { TextFiles } from './review.js';
import { contextSnapshot } from './context.js';
import type { Attachment } from './state.js';
import type { Change } from './review-types.js';
import { reviewImages, reviewSummary } from './review-presentation.js';
import { reviewHunks } from './review-hunks.js';
import path from 'node:path';

export class WorkspaceFiles implements TextFiles {
  readonly reviewSnapshots = new Map<string, string>();
  constructor(private readonly host: vscode.Uri) {}

  async review(change: Change, hunkId?: string): Promise<void> {
    const hunk = reviewHunks(change).find((candidate) => candidate.id === hunkId);
    if (hunkId && !hunk) throw new Error('Review hunk is stale or no longer available.');
    const images = reviewImages(change).map((image) => {
      const uri = vscode.Uri.from({ scheme: 'omp-review', path: image.path });
      this.reviewSnapshots.set(uri.toString(), image.text);
      return uri;
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      ...images,
      `${reviewSummary(change, path.basename).name} (OMP Changes)`,
      {
        preview: true,
        ...(hunk
          ? {
              selection: new vscode.Range(
                Math.max(0, hunk.newStart - 1),
                0,
                Math.max(0, hunk.newStart - 1),
                0,
              ),
            }
          : {}),
      },
    );
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
        { label: '$(file-text) Open Text Resources...', value: 'resources' },
        { label: '$(warning) Workspace Problems', value: 'diagnostics' },
      ],
      { title: 'Add Context', ignoreFocusOut: true },
    );
    if (!picked) return [];
    if (picked.value === 'editor') return [this.editorContext()];
    if (picked.value === 'diagnostics') return [this.diagnosticsContext()];
    if (picked.value === 'resources') return this.resourceContexts();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: 'Attach',
    });
    const snapshots: Attachment[] = [];
    for (const uri of uris ?? []) {
      if (uri.scheme !== this.host.scheme || uri.authority !== this.host.authority)
        throw new Error('Choose a file on the active workspace host.');
      const text = await this.read(uri.fsPath);
      if (text === null) throw new Error('The selected file no longer exists.');
      snapshots.push(contextSnapshot('file', path.basename(uri.path), uri.toString(), text));
    }
    return snapshots;
  }

  private async resourceContexts(): Promise<Attachment[]> {
    const resources = vscode.workspace.textDocuments.filter(
      (document) =>
        document.uri.scheme === 'untitled' ||
        (document.uri.scheme === this.host.scheme &&
          document.uri.authority === this.host.authority),
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

  async read(target: string): Promise<string | null> {
    const uri = this.uri(target);
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    try {
      const text = await this.diskText(uri);
      return document?.getText() ?? text;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound')
        return document?.isDirty ? document.getText() : null;
      throw error;
    }
  }

  async replace(target: string, expected: string | null, content: string | null): Promise<void> {
    const uri = this.uri(target);
    if ((await this.read(target)) !== expected)
      throw new Error('File or editor buffer changed before the operation could be applied.');
    const edit = await this.replacement(uri, expected, content);
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
      const end = document?.positionAt(document.getText().length) ?? new vscode.Position(0, 0);
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
    }
    return edit;
  }
}
