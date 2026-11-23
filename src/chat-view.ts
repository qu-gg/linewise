import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Approvals } from './approvals.js';
import { Questions } from './questions.js';
import { Attention, type AttentionEvent, type AttentionPolicy } from './attention.js';
import type { RequestApproval } from './approvals.js';
import type { webviewMessage } from './state.js';
import { fileApproval } from './approval-prompts.js';
import type { Approval } from './review.js';

export function isChatRequest(request: ReturnType<typeof webviewMessage.parse>): boolean {
  return [
    'approval',
    'approvalSettings',
    'questionAnswer',
    'questionCancel',
    'focus',
    'refreshSessions',
    'ready',
    'output',
  ].includes(request.type);
}

export class ChatView {
  private view: vscode.WebviewView | undefined;
  private focused = false;
  private readonly attention = new Attention();
  readonly approvals = new Approvals(() => this.publish());
  readonly questions = new Questions(() => this.publish());

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

  readonly requestQuestions: Questions['request'] = (request, signal, valid) => {
    const view = this.view;
    return this.questions.request(
      request,
      signal,
      () => Boolean(view) && this.view === view && vscode.workspace.isTrusted && valid(),
    );
  };

  presentation() {
    return { ...this.approvals.snapshot(), ...this.questions.snapshot() };
  }

  resolve(view: vscode.WebviewView): void {
    this.focused = false;
    this.approvals.cancel();
    this.questions.cancel();
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
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('main.css')}"><title>Linewise</title></head><body><main id="app"></main><script nonce="${nonce}" src="${resource('main.js')}"></script></body></html>`;
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
    if (request.type === 'focus') {
      this.focused = request.focused;
      return true;
    }
    if (request.type === 'questionAnswer') {
      this.questions.answer(request.id, request.answers);
      return true;
    }
    if (request.type === 'questionCancel') {
      this.questions.cancel(request.id);
      return true;
    }
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
        this.questions.cancel();
        this.publish();
      },
      output: () => this.output.show(),
      refreshSessions: () => this.publish(),
    };
    const action = actions[request.type];
    if (!action) return false;
    action();
    return true;
  }

  publish(): void {
    const state = this.snapshot();
    this.post({ v: 1, type: 'state', state });
    const focused =
      this.focused && this.view?.visible !== false && vscode.window.state?.focused !== false;
    for (const event of this.attention.observe(state, this.notificationPolicy(), focused))
      void this.notify(event).catch(() =>
        this.output.appendLine('OMP notification could not be displayed.'),
      );
  }

  private notificationPolicy(): AttentionPolicy {
    const config = vscode.workspace.getConfiguration('omp');
    return {
      enabled: config.get('notifications.enabled', true),
      approval: config.get('notifications.approval', true),
      questions: config.get('notifications.questions', true),
      finished: config.get('notifications.finished', true),
      backgroundOnly: config.get('notifications.focus', 'background') === 'background',
    };
  }

  private async notify(event: AttentionEvent): Promise<void> {
    const messages = {
      approval: ['Linewise: Need approval', 'Review Approval'],
      questions: ['Linewise: Has questions', 'Answer Questions'],
      finished: ['Linewise: Session finished', 'Open Session'],
    } as const;
    const [message, action] = messages[event.kind]!;
    if ((await vscode.window.showInformationMessage(message, action)) !== action) return;
    if (!this.attention.current(event, this.snapshot())) return;
    await vscode.commands.executeCommand('omp.chat.focus');
    if (!this.attention.current(event, this.snapshot())) return;
    this.view?.show(false);
    this.post({ v: 1, type: 'focusAttention', ...event });
  }

  readonly focusTerminals = (sessionId: string): void => {
    this.view?.show(false);
    this.post({ v: 1, type: 'focusTerminals', sessionId });
  };

  post(message: unknown): void {
    const view = this.view;
    if (!view) return;
    const failed = () => {
      if (this.view === view) {
        this.approvals.cancel();
        this.questions.cancel();
      }
    };
    void view.webview.postMessage(message).then((delivered) => {
      if (!delivered) failed();
    }, failed);
  }

  dispose(): void {
    this.view = undefined;
    this.focused = false;
    this.approvals.cancel();
    this.questions.cancel();
  }
}
