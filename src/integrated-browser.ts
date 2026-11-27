import * as vscode from 'vscode';

export type BrowserOpen = 'integrated' | 'external';
export async function openIntegratedBrowser(
  target: string,
  output?: vscode.OutputChannel,
): Promise<BrowserOpen> {
  const uri = vscode.Uri.parse(target, true);
  if (!['http', 'https'].includes(uri.scheme))
    throw new Error('Only HTTP(S) URLs can be opened in the integrated browser.');
  try {
    await vscode.commands.executeCommand('workbench.action.browser.open', {
      url: uri.toString(),
      openToSide: false,
    });
    return 'integrated';
  } catch (error) {
    output?.appendLine(
      `Integrated browser is unavailable; opening externally. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (!(await vscode.env.openExternal(uri)))
      throw new Error('The URL could not be opened.', { cause: error });
    return 'external';
  }
}
