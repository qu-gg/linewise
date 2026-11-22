import { z } from 'zod';
import { shellInput } from './terminal-policy.js';

export const shellRequest = z.union([
  shellInput.extend({
    action: z.enum(['run', 'start']).optional(),
    runtime: z.enum(['shell', 'node']).optional(),
  }),
  z
    .object({
      action: z.enum(['output', 'stop']),
      jobId: z.uuid(),
      waitMs: z.number().int().min(0).max(10000).optional(),
      i: z.string().nullish(),
    })
    .strict(),
  z
    .object({
      action: z.enum(['wait', 'reveal', 'takeover']),
      jobId: z.uuid(),
      i: z.string().nullish(),
    })
    .strict(),
]);

export type ShellRequest = z.infer<typeof shellRequest>;

export function shellPermission(input: unknown): string | undefined {
  const parsed = shellRequest.safeParse(input);
  if (!parsed.success) return;
  const { i: _intent, ...request } = parsed.data;
  if (
    'command' in request &&
    !request.action &&
    !request.runtime &&
    !request.pty &&
    !request.visibility
  )
    return JSON.stringify({ command: request.command });
  return JSON.stringify(request);
}
