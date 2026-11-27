import * as vscode from 'vscode';
import type { Attachment, SavedSession, StateStore } from './state.js';

interface Application {
  perform(action: () => Promise<void>): Promise<void>;
  preflight(): Promise<void>;
  connect(fresh?: boolean, selected?: SavedSession): Promise<void>;
  cancel(): Promise<void>;
  switchSession(): Promise<void>;
  closeBrowser(): Promise<void>;
  openInBrowser(url?: string): Promise<void>;
  dispatch(message: unknown): Promise<void>;
}

export function registerHostCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  application: Application,
) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      application.perform(async () => {
        try {
          await application.cancel();
        } catch (error) {
          await application.closeBrowser();
          throw error;
        }
      }),
    ),
    vscode.commands.registerCommand('omp.open', () =>
      vscode.commands.executeCommand('omp.chat.focus'),
    ),
    vscode.commands.registerCommand('omp.preflight', () =>
      application.perform(() => application.preflight()),
    ),
    vscode.commands.registerCommand('omp.newSession', () =>
      application.perform(() => application.connect(true)),
    ),
    vscode.commands.registerCommand('omp.sessions', () =>
      application.perform(() => application.switchSession()),
    ),
    vscode.commands.registerCommand('omp.stop', () =>
      application.perform(() => application.cancel()),
    ),
    vscode.commands.registerCommand('omp.showOutput', () => output.show()),
    vscode.commands.registerCommand('omp.closeBrowser', () =>
      application.perform(() => application.closeBrowser()),
    ),
    vscode.commands.registerCommand('omp.openInBrowser', async (target?: string | vscode.Uri) => {
      const url = target instanceof vscode.Uri ? target.toString() : target;
      if (url) return application.perform(() => application.openInBrowser(url));
      const input = await vscode.window.showInputBox({
        prompt: 'URL to open in the VS Code integrated browser',
        placeHolder: 'http://localhost:3000',
      });
      if (input) return application.perform(() => application.openInBrowser(input));
    }),
  );
}

export function testSurface(
  context: vscode.ExtensionContext,
  storage: StateStore,
  application: Application,
  attach: (snapshots: Attachment[]) => Promise<void>,
) {
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        request: (message: unknown) => application.dispatch(message),
        storedState: () => structuredClone(storage.data),
        attachSnapshots: attach,
        resume: (id: string, legacy = false) => {
          const saved = storage.data.sessions.find((session) => session.id === id);
          if (!saved) throw new Error('Unknown test session.');
          if (legacy) saved.sessionFile = undefined;
          return application.connect(false, saved);
        },
      }
    : {};
}
