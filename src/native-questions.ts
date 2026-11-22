import path from 'node:path';
import { z } from 'zod';
import type { NativeEditApi } from './native-edit.js';
import { questionRequest } from './question-policy.js';
import { exchangeResult } from './mutations.js';

export function installNativeQuestions(api: Pick<NativeEditApi, 'registerTool'>): void {
  api.registerTool({
    name: 'ask',
    label: 'Ask Questions',
    approval: 'read',
    defaultInactive: true,
    description:
      'Ask the user up to four concise clarifying questions through native VS Code controls. Supports exact choices, multiple selection, optional free text and dismissal. For free-text-only input set options to null and allowFreeformInput to true; never invent placeholder choices. Never request passwords, tokens or other secrets. No files or commands are changed. Stop cancels pending input; answers are returned only to this prompt. Do not invent an answer after cancellation.',
    parameters: z.toJSONSchema(questionRequest),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const request = questionRequest.parse(input);
      const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
      if (!artifacts) throw new Error('Private question storage is unavailable.');
      const text = await exchangeResult(
        path.join(artifacts, 'mutations'),
        [{ op: 'questions', request }],
        signal,
        toolCallId,
      );
      return { content: [{ type: 'text', text: text! }], isError: false };
    },
  });
}
