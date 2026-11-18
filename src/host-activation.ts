import * as vscode from 'vscode';
import type { SavedSession, StateStore } from './state.js';

interface Application {
  perform(action: () => Promise<void>): Promise<void>;
  preflight(): Promise<void>;
  connect(fresh?: boolean, selected?: SavedSession): Promise<void>;
  switchSession(): Promise<void>;
  cancel(): Promise<void>;
  dispatch(message: unknown): Promise<void>;
}

export function registerHostCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  application: Application,
) {
  context.subscriptions.push(
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
  );
}

export function testSurface(
  context: vscode.ExtensionContext,
  storage: StateStore,
  application: Application,
) {
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        request: (message: unknown) => application.dispatch(message),
        storedState: () => structuredClone(storage.data),
        resume: (id: string, legacy = false) => {
          const saved = storage.data.sessions.find((session) => session.id === id);
          if (!saved) throw new Error('Unknown test session.');
          if (legacy) saved.sessionFile = undefined;
          return application.connect(false, saved);
        },
      }
    : {};
}
