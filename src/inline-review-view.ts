import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Change } from './review-types.js';
import { editedProposal, editableProposal } from './review-types.js';
import { inlineReview, reviewImages, reviewSummary } from './review-presentation.js';
import { reviewHunks } from './review-hunks.js';

export interface EditorReviewHost {
  changes: () => readonly Change[];
  available: () => boolean;
  dispatch: (request: unknown) => Promise<void>;
  edit: (id: string, text: string) => Promise<void>;
  reset: (id: string) => Promise<void>;
}

interface ReviewFiles {
  reviewSnapshots: Map<string, string>;
  reviewSelections: Map<string, string | undefined>;
  reviewRequested: vscode.EventEmitter<{ uri: vscode.Uri; hunkId?: string }>;
  review: (change: Change, hunkId?: string) => Promise<void>;
  read: (target: string) => Promise<string | null>;
  uri: (target: string) => vscode.Uri;
}

interface OpenReview {
  document: vscode.CustomDocument;
  panel: vscode.WebviewPanel;
  revision: string;
  line: number;
  last: Change;
  problem?: string;
  listeners: vscode.Disposable[];
}

function reviewProblem(change?: Change): string | undefined {
  if (!change) return 'Review unavailable.';
  if (change.state === 'conflict') return 'File changed outside OMP.';
}

function reviewRequest(change: Change, keep: boolean, hunkId?: string, text?: string) {
  return {
    v: 1,
    id: change.id,
    type: hunkId ? (keep ? 'hunkKeep' : 'hunkDiscard') : keep ? 'keep' : 'discard',
    ...(hunkId ? { hunkId } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

export class InlineReviewView implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  private readonly opened = new Map<vscode.WebviewPanel, OpenReview>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly files: ReviewFiles,
    private readonly host: EditorReviewHost,
    private readonly changed: () => void,
  ) {}

  register(): vscode.Disposable[] {
    return [
      vscode.window.registerCustomEditorProvider('omp.inlineReview', this, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      this.files.reviewRequested.event(({ uri, hunkId }) => {
        for (const entry of this.opened.values())
          if (entry.document.uri.toString() === uri.toString()) this.publish(entry, hunkId);
      }),
    ];
  }

  private current(uri: vscode.Uri): Change | undefined {
    if (uri.scheme !== 'omp-review' || !this.files.reviewSnapshots.has(uri.toString())) return;
    return this.host.changes().find((change) => uri.path === reviewImages(change)[1]!.path);
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    if (!this.current(uri)) throw new Error('OMP review is not owned by the active session.');
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const last = this.current(document.uri);
    if (!last) throw new Error('OMP review is no longer available.');
    const entry: OpenReview = { document, panel, last, revision: '', line: 1, listeners: [] };
    this.opened.set(panel, entry);
    panel.title = `${reviewSummary(last, path.basename).name} (Linewise Changes)`;
    const webview = panel.webview;
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const resource = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString();
    const nonce = randomBytes(18).toString('base64');
    webview.options = { enableScripts: true, localResourceRoots: [base] };
    entry.listeners.push(
      webview.onDidReceiveMessage((message: unknown) => this.receive(entry, message)),
      panel.onDidChangeViewState(() => this.changed()),
      panel.onDidDispose(() => {
        this.opened.delete(panel);
        for (const listener of entry.listeners) listener.dispose();
        this.changed();
      }),
    );
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; worker-src blob:;"><link rel="stylesheet" href="${resource('inline-review.css')}"><title>Linewise Changes</title></head><body data-worker="${resource('inline-worker.js')}"><div id="toolbar" role="toolbar" aria-label="Review actions" hidden></div><div id="surface"><main id="editor"></main><div id="overview" role="img" aria-label="Change overview"></div></div><div id="overview-summary" class="visually-hidden" role="status"></div><div id="status" role="status" hidden></div><script nonce="${nonce}" src="${resource('inline-review.js')}"></script></body></html>`;
    this.publish(entry, this.files.reviewSelections.get(document.uri.toString()));
    this.changed();
  }

  private publish(entry: OpenReview, hunkId?: string): void {
    if (!this.opened.has(entry.panel)) return;
    const change = this.current(entry.document.uri);
    if (change) entry.last = change;
    const presentation = inlineReview(entry.last);
    entry.revision = randomBytes(12).toString('hex');
    const line = presentation.hunks.find((hunk) => hunk.id === hunkId)?.line;
    if (line) entry.line = line;
    void entry.panel.webview
      .postMessage(this.snapshot(entry, change, presentation, line))
      .then(undefined, () => {});
  }

  private snapshot(
    entry: OpenReview,
    change: Change | undefined,
    presentation: ReturnType<typeof inlineReview>,
    line?: number,
  ) {
    const pending = change?.state === 'pending';
    const language = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === this.files.uri(entry.last.path).toString(),
    )?.languageId;
    return {
      type: 'inlineReview',
      ...presentation,
      changeId: entry.last.id,
      revision: entry.revision,
      pending,
      available: Boolean(pending && this.host.available()),
      editable: Boolean(pending && change && editableProposal(change)),
      edited: Boolean(change && editedProposal(change)),
      language,
      extension: path.extname(entry.last.destination?.path ?? entry.last.path),
      ...(line ? { line } : {}),
      ...(!pending ? { parts: [], hunks: [] } : {}),
      problem: entry.problem ?? reviewProblem(change),
    };
  }

  private cursor(entry: OpenReview, data: Record<string, unknown>): boolean {
    if (data.type !== 'cursor') return false;
    if (Number.isSafeInteger(data.line) && Number(data.line) > 0) entry.line = Number(data.line);
    return true;
  }

  private validAction(change: Change, data: Record<string, unknown>): boolean {
    if (data.type !== 'reviewAction' || !['keep', 'discard'].includes(String(data.operation)))
      return false;
    if (!this.host.available() || change.state !== 'pending') return false;
    if (data.hunkId !== undefined && editedProposal(change)) return false;
    const hunks = reviewHunks(change);
    return data.hunkId === undefined
      ? editedProposal(change) || hunks.length === 0
      : hunks.some((hunk) => hunk.id === data.hunkId);
  }

  private packet(entry: OpenReview, message: unknown): Record<string, unknown> | undefined {
    if (!this.opened.has(entry.panel) || !message || typeof message !== 'object') return;
    return message as Record<string, unknown>;
  }

  private async receive(entry: OpenReview, message: unknown): Promise<void> {
    const data = this.packet(entry, message);
    if (!data) return;
    if (data.type === 'ready') {
      this.publish(entry, this.files.reviewSelections.get(entry.document.uri.toString()));
      return;
    }
    const change = this.current(entry.document.uri);
    if (!change || data.changeId !== change.id || data.revision !== entry.revision) {
      this.publish(entry);
      return;
    }
    if (this.cursor(entry, data)) return;
    if (data.type === 'proposal') return this.proposal(entry, change, data);
    if (data.type === 'reset') return this.reset(entry, change);
    if (!this.validAction(change, data)) {
      this.publish(entry);
      return;
    }
    return this.action(entry, change, data);
  }

  private async proposal(
    entry: OpenReview,
    change: Change,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (
      typeof data.text !== 'string' ||
      data.text.length > 1_048_576 ||
      !editableProposal(change)
    ) {
      this.publish(entry);
      return;
    }
    try {
      entry.problem = undefined;
      await this.host.edit(change.id, data.text);
    } catch (error) {
      entry.problem = error instanceof Error ? error.message : 'Could not edit the proposal.';
    } finally {
      this.refresh();
    }
  }

  private async reset(entry: OpenReview, change: Change): Promise<void> {
    try {
      entry.problem = undefined;
      await this.host.reset(change.id);
    } catch (error) {
      entry.problem = error instanceof Error ? error.message : 'Could not reset the proposal.';
    } finally {
      this.refresh();
    }
  }

  private async action(
    entry: OpenReview,
    change: Change,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.resolve(
        entry,
        change,
        data.operation === 'keep',
        data.hunkId as string | undefined,
        typeof data.text === 'string' ? data.text : undefined,
      );
    } catch (error) {
      entry.problem = error instanceof Error ? error.message : 'Could not resolve change.';
    } finally {
      this.refresh();
    }
  }

  private async resolve(
    entry: OpenReview,
    change: Change,
    keep: boolean,
    hunkId?: string,
    text?: string,
  ): Promise<void> {
    entry.problem = undefined;
    await this.host.dispatch(reviewRequest(change, keep, hunkId, text));
    if (this.current(entry.document.uri)?.state === 'pending' || !this.opened.has(entry.panel))
      return;
    await this.revealFile(entry, change);
  }

  private async revealFile(entry: OpenReview, change: Change): Promise<void> {
    const targets = [change.destination?.path, change.path].filter((target): target is string =>
      Boolean(target),
    );
    let target = targets[0]!;
    if ((await this.files.read(target)) === null) target = change.path;
    const exists = (await this.files.read(target)) !== null;
    const active = entry.panel.active;
    entry.panel.dispose();
    if (exists && active)
      await vscode.commands.executeCommand('vscode.openWith', this.files.uri(target), 'default', {
        preview: true,
      });
  }

  get available(): boolean {
    return (
      this.host.available() &&
      [...this.opened.values()].some(
        (entry) => entry.panel.active && this.current(entry.document.uri)?.state === 'pending',
      )
    );
  }

  async atCursor(action: 'Previous' | 'Next' | 'Keep' | 'Discard'): Promise<boolean> {
    const entry = [...this.opened.values()].find((item) => item.panel.active);
    if (!entry) return false;
    const change = this.current(entry.document.uri);
    if (!change || !this.available)
      throw new Error('Select an idle, current OMP change to review.');
    if (editedProposal(change))
      throw new Error('Reset to suggestion before resolving individual hunks.');
    const hunks = inlineReview(change).hunks;
    const index = hunks.reduce(
      (selected, hunk, position) => (hunk.line <= entry.line ? position : selected),
      0,
    );
    if (action === 'Previous' || action === 'Next') {
      if (hunks.length)
        await this.files.review(
          change,
          hunks[(index + (action === 'Previous' ? -1 : 1) + hunks.length) % hunks.length]!.id,
        );
    } else {
      await this.resolve(entry, change, action === 'Keep', hunks[index]?.id);
      this.refresh();
    }
    return true;
  }

  refresh(): void {
    for (const entry of this.opened.values()) this.publish(entry);
  }

  dispose(): void {
    const entries = [...this.opened.values()];
    this.opened.clear();
    for (const entry of entries) {
      for (const listener of entry.listeners) listener.dispose();
      entry.panel.dispose();
    }
  }
}
