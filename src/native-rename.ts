import path from 'node:path';
import { z } from 'zod';
import type { NativeEditApi } from './native-edit.js';
import { renameRequest } from './rename-policy.js';
import { cleanupPermit, exchangeResult, stagePermit } from './mutations.js';

function directory(): string {
  const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
  if (!artifacts) throw new Error('Private rename storage is unavailable.');
  return path.join(artifacts, 'mutations');
}

export function installNativeRename(api: NativeEditApi): void {
  api.on('tool_call', async (event) => {
    if (event.toolName === 'rename')
      await stagePermit(
        directory(),
        event.toolCallId,
        JSON.stringify(renameRequest.parse(event.input)),
      );
  });
  api.on('tool_result', async (event) => {
    if (event.toolName === 'rename') await cleanupPermit(directory(), event.toolCallId);
  });
  api.registerTool({
    name: 'rename',
    label: 'Rename Symbol',
    approval: 'write',
    defaultInactive: true,
    description:
      'Rename a symbol through the installed VS Code language provider and OMP file review. Supply source path, 1-based line/column, newName, and paths listing every potentially affected file (1-8, including source). Discover references/read files first. ' +
      'Only saved canonical workspace text files are supported (1 MiB/file, 4 MiB captured, 1000 edits). Uncaptured/private/outside targets, dirty or changed preimages and unsafe edits are refused before writes. No provider means an error, not a textual fallback. ' +
      'Only enumerated plain text edits are copied into the existing durable Keep/Discard journal; provider file operations, commands and snippets are never forwarded. No file creation/deletion/moves. ' +
      'This is not an atomic multi-file transaction: Stop/conflicts may leave a partially applied rename, with all applied or interrupted changes still in review. Inspect and resolve review before retrying.',
    parameters: z.toJSONSchema(renameRequest),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const request = renameRequest.parse(input);
      const text = await exchangeResult(
        directory(),
        [{ op: 'rename', request }],
        signal,
        toolCallId,
      );
      return { content: [{ type: 'text', text: text! }], isError: false };
    },
  });
}
