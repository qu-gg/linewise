import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import { collectPullRequestEvidence, formatPullRequestBody } from './pr-evidence.js';

export async function preparePullRequest(output: OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a workspace folder before preparing a pull request.');
    return;
  }
  const abort = new AbortController();
  try {
    const evidence = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing pull request',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        return collectPullRequestEvidence({
          cwd: folder.uri.fsPath,
          signal: abort.signal,
          report: (message) => progress.report({ message }),
        });
      },
    );
    const body = formatPullRequestBody(evidence);
    const document = await vscode.workspace.openTextDocument({
      content: body,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.env.clipboard.writeText(body);
    void vscode.window.showInformationMessage(
      'Pull request body copied to the clipboard after the verification gate passed.',
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Pull request preparation was cancelled or failed.';
    output.appendLine(message);
    const action = await vscode.window.showErrorMessage(message, 'Show Output');
    if (action === 'Show Output') output.show();
  }
}
