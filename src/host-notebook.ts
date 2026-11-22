import * as vscode from 'vscode';
import { notebookRequest, replaceNotebookCell, type NotebookRequest } from './notebook-policy.js';
import { reviewProviderEdits } from './host-rename.js';

export async function editNotebook(
  value: NotebookRequest,
  scope: Parameters<typeof reviewProviderEdits>[1],
  write: Parameters<typeof reviewProviderEdits>[2],
): Promise<string> {
  const input = notebookRequest.parse(value);
  return reviewProviderEdits(
    { path: input.path, paths: [input.path] },
    scope,
    write,
    async (document) => {
      if (
        vscode.workspace.notebookDocuments.some(
          (notebook) => notebook.uri.toString() === document.uri.toString() && notebook.isDirty,
        )
      )
        throw new Error('Save or close the dirty notebook before editing a cell.');
      const content = replaceNotebookCell(document.getText(), input);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
        content,
      );
      return edit;
    },
    'notebook edit',
  );
}
