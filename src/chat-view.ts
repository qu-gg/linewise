import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Approvals } from './approvals.js';
import type { RequestApproval } from './approvals.js';
import type { webviewMessage } from './state.js';
import { fileApproval } from './approval-prompts.js';
import type { Approval } from './review.js';

export function isChatRequest(request: ReturnType<typeof webviewMessage.parse>): boolean {
  return ['approval', 'approvalSettings', 'ready', 'output'].includes(request.type);
}

export class ChatView {
  private view: vscode.WebviewView | undefined;
  readonly approvals = new Approvals(() => this.publish());

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'subscriptions' | 'extensionUri'>,
    private readonly output: vscode.OutputChannel,
    private readonly snapshot: () => unknown,
    private readonly dispatch: (message: unknown) => Promise<void>,
    private readonly fileOwner: () => () => boolean = () => () => false,
  ) {}

  requestFile(operation: Parameters<Approval>[0], signal?: AbortSignal): Promise<boolean> {
    if (!signal) return Promise.resolve(false);
    return this.requestApproval(fileApproval(operation), signal, this.fileOwner());
  }

  readonly requestApproval: RequestApproval = (prompt, signal, valid) => {
    const view = this.view;
    if (!view) return Promise.resolve(false);
    return this.approvals.request(
      prompt,
      signal,
      () => this.view === view && vscode.workspace.isTrusted && valid(),
    );
  };

  resolve(view: vscode.WebviewView): void {
    this.approvals.cancel();
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };
    const resource = (file: string) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', file))
        .toString();
    const nonce = randomBytes(18).toString('base64');
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('main.css')}"><title>OMP</title></head><body><main id="app"></main><script nonce="${nonce}" src="${resource('main.js')}"></script></body></html>`;
    this.context.subscriptions.push(
      webview.onDidReceiveMessage((message) => {
        if (this.view === view) void this.dispatch(message);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.dispose();
      }),
    );
    this.publish();
  }

  async localAction(request: ReturnType<typeof webviewMessage.parse>): Promise<boolean> {
    if (request.type === 'approval') {
      this.approvals.decide(request.id, request.decision === 'allow');
      return true;
    }
    if (request.type === 'approvalSettings') {
      const active = this.approvals.snapshot().approval;
      if (active?.id === request.id && active.configurable)
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@id:omp.permissions.commandRules',
        );
      return true;
    }
    const actions: Record<string, () => void> = {
      ready: () => {
        this.approvals.cancel();
        this.publish();
      },
      output: () => this.output.show(),
    };
    const action = actions[request.type];
    if (!action) return false;
    action();
    return true;
  }

  publish(): void {
    this.post({ v: 1, type: 'state', state: this.snapshot() });
  }

  post(message: unknown): void {
    const view = this.view;
    if (!view) return;
    const failed = () => {
      if (this.view === view) this.approvals.cancel();
    };
    void view.webview.postMessage(message).then((delivered) => {
      if (!delivered) failed();
    }, failed);
  }

  dispose(): void {
    this.view = undefined;
    this.approvals.cancel();
  }
}
