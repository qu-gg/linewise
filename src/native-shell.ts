import path from 'node:path';
import { z } from 'zod';
import type { NativeEditApi } from './native-edit.js';
import { exchangeResult } from './mutations.js';
import { shellRequest } from './shell-policy.js';
import { providerObjectSchema } from './tool-schema.js';

export function installNativeShell(api: Pick<NativeEditApi, 'registerTool'>): void {
  api.registerTool({
    name: 'bash',
    label: 'Command',
    approval: 'write',
    defaultInactive: true,
    strict: false,
    description:
      'Run host-approved commands. Approval and execution have no timeout by default. A positive timeout (up to 120 seconds) opts into a post-approval execution deadline; 0, null or omission means no deadline. ' +
      'Default action run waits for completion. Use action start for a managed background job or foreground server, then action output, wait or stop with its jobId. ' +
      'Use action wait once when ready for completion: it holds without a deadline or repeated status queries and returns final bounded output/status. You may do other permitted work before waiting. Completed handles remain until stop or prompt cleanup. ' +
      'Use output waitMs up to 10000 to wait for initial startup output. Managed servers are owned by this prompt and are stopped on completion, Stop or disconnect. Do not detach with &, nohup or setsid. ' +
      'For JavaScript or Playwright use runtime node: command is JavaScript ESM source, executed by the host Node 20+ runtime rather than shell node. ' +
      'Input style pty:true and visibility hidden/background/foreground are independent of run/start scheduling; defaults are pty:false and hidden. Use reveal with an owned jobId to focus its terminal. Use takeover on a running PTY for direct human input/authentication: it holds until Resume Agent and actual command completion. Never put secrets into model tools. Capture is permanently withheld for that execution before human input is enabled; early Resume is not completion or success. Cancel/dismissal stops the command. ' +
      'No native service/async mode, proc://, xd:// or URL read tools. Read accepts local files only. ' +
      'Use grep/find when rg is unavailable. Shell effects are not sandboxed or covered by file review.',
    parameters: providerObjectSchema(z.toJSONSchema(shellRequest)),
    async execute(toolCallId, input: unknown, signal) {
      signal?.throwIfAborted();
      const request = shellRequest.parse(input);
      const artifacts = process.env.VS_OMP_ARTIFACTS_ROOT;
      if (!artifacts) throw new Error('Private command storage is unavailable.');
      const text = await exchangeResult(
        path.join(artifacts, 'mutations'),
        [{ op: 'shell', request }],
        signal,
        toolCallId,
      );
      const result = JSON.parse(text!);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: Boolean(
          request.action !== 'stop' && result.exitStatus && result.exitStatus.exitCode !== 0,
        ),
        details: result,
      };
    },
  });
}
