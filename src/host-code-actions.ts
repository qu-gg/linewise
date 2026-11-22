import * as vscode from 'vscode';
import { actionTitle } from './code-action-policy.js';
import type { CodeActionRequest } from './code-action-policy.js';
import { documentPosition, inspectProviderResult, reviewProviderEdits } from './host-rename.js';
import type { RenameImage } from './host-rename.js';

type Scope = Parameters<typeof reviewProviderEdits>[1];
type Action = vscode.CodeAction | vscode.Command;

function resourceReason(kind?: string) {
  if (kind === 'refactor.move' || kind?.startsWith('refactor.move.'))
    return 'resource-operations-uninspectable';
}

function metadata(action: Action, kind: string) {
  const title = actionTitle.parse(action.title);
  const code = action as vscode.CodeAction;
  const value = code.kind?.value;
  const matching = typeof value === 'string' && (value === kind || value.startsWith(`${kind}.`));
  const unavailableReason = resourceReason(value);
  const commandIgnored = action.command !== undefined;
  return {
    title,
    kind: typeof value === 'string' ? actionTitle.parse(value) : null,
    available: matching && !unavailableReason && !code.disabled && Boolean(code.edit?.size),
    disabled: Boolean(code.disabled),
    commandIgnored,
    unavailableReason,
  };
}

async function actions(input: CodeActionRequest, document: vscode.TextDocument): Promise<Action[]> {
  const range = new vscode.Range(
    documentPosition(document, input.line, input.column),
    documentPosition(document, input.endLine, input.endColumn),
  );
  const result = await vscode.commands.executeCommand<Action[] | undefined>(
    'vscode.executeCodeActionProvider',
    document.uri,
    range,
    input.kind,
    32,
  );
  if (result === undefined) return [];
  if (!Array.isArray(result) || result.length > 32)
    throw new Error('Code action provider exceeds 32 actions or returned an unsupported result.');
  return result;
}

export async function codeActionsWorkspace(
  input: CodeActionRequest,
  scope: Scope,
  write: (image: RenameImage) => Promise<void>,
): Promise<string> {
  if (input.action === 'list') {
    const result = await inspectProviderResult(input, scope, async (document) =>
      (await actions(input, document)).map((action) => metadata(action, input.kind)),
    );
    return JSON.stringify({ actions: result, untrusted: true, textOnly: true });
  }
  return reviewProviderEdits(
    input,
    scope,
    write,
    async (document) => {
      const result = (await actions(input, document)).filter(
        (action) => action.title === input.title,
      );
      if (result.length !== 1)
        throw new Error('Code action title is unavailable or ambiguous; list fresh actions first.');
      const selected = result[0]!;
      if (!metadata(selected, input.kind).available)
        throw new Error(
          'Code action is disabled, lacks matching kind, requires unsupported resource operations or has no resolved text edit; command-only actions are unavailable.',
        );
      return (selected as vscode.CodeAction).edit;
    },
    'code action',
  );
}
