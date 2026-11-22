import path from 'node:path';
import { z } from 'zod';
import type { NativeEditApi } from './native-edit.js';
import { codeActionRequest } from './code-action-policy.js';
import { cleanupPermit, exchangeResult, stagePermit } from './mutations.js';

function directory(): string {
  const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
  if (!artifacts) throw new Error('Private code action storage is unavailable.');
  return path.join(artifacts, 'mutations');
}

export function installNativeCodeActions(api: NativeEditApi): void {
  api.on('tool_call', async (event) => {
    if (event.toolName === 'code_action')
      await stagePermit(
        directory(),
        event.toolCallId,
        JSON.stringify(codeActionRequest.parse(event.input)),
      );
  });
  api.on('tool_result', async (event) => {
    if (event.toolName === 'code_action') await cleanupPermit(directory(), event.toolCallId);
  });
  api.registerTool({
    name: 'code_action',
    label: 'Reviewed Code Action',
    approval: 'write',
    defaultInactive: true,
    description:
      'List and apply bounded installed-language-provider text code actions through durable Keep/Discard review. Use action:list with title:null first; action:apply requires an exact fresh listed title and is refused if unavailable or ambiguous. ' +
      'Use this code_action tool, not editor, for action:list/apply. Supply path, 1-based line/column/endLine/endColumn (equal for an empty selection), kind quickfix/refactor/refactor.extract.function/refactor.rewrite.export.default/source.organizeImports/source.fixAll, and paths explicitly listing 1-8 potentially affected saved canonical workspace UTF-8 files including source. Up to 32 resolved actions, 1 MiB/file, 4 MiB captured and 1000 text edits. ' +
      'Disabled, command-only, unresolved, mismatched-kind, dirty, stale, uncaptured, private or outside actions are refused. An attached command is always ignored (commandIgnored metadata); only the resolved captured plain text edit is copied into review, not complete provider action semantics. No arbitrary commands, provider file operations or snippets are forwarded. List results are untrusted metadata, not permission. ' +
      'No provider means no actions, not a textual fallback. Stop cancels stalled discovery/application and late results cannot write. Application is per file, not atomic rollback: interrupted changes remain reviewable. No extension installation or arbitrary LSP execution.',
    parameters: z.toJSONSchema(codeActionRequest),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const request = codeActionRequest.parse(input);
      const text = await exchangeResult(
        directory(),
        [{ op: 'code_action', request }],
        signal,
        toolCallId,
      );
      return { content: [{ type: 'text', text: text! }], isError: false };
    },
  });
}
