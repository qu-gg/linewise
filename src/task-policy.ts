import { z } from 'zod';

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value) && !value.includes('${'));

export const taskReadiness = z.object({ line: label }).strict();

export const taskRequest = z
  .object({
    name: label,
    source: label,
    timeout: z.number().int().min(1).max(120).nullish(),
    graph: z
      .array(
        z
          .object({
            id: label,
            name: label,
            source: label,
            dependsOn: z.array(label).max(4).default([]),
            readiness: taskReadiness.nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .optional(),
  })
  .strict();

export type TaskRequest = z.infer<typeof taskRequest>;

export function taskShellCommand(execution: {
  commandLine?: string;
  command?: unknown;
  args?: unknown[];
  options?: { executable?: string; shellArgs?: string[] };
}) {
  if (execution.options?.executable || execution.options?.shellArgs)
    throw new Error('Task custom shells are unsupported; use a concrete process task.');
  let command = execution.commandLine;
  if (command === undefined) {
    const words = [execution.command, ...(execution.args ?? [])];
    if (!words.every((word): word is string => typeof word === 'string'))
      throw new Error('Task shell quoting objects are unsupported; use literal string arguments.');
    command = words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
  }
  return { command: '/bin/bash', args: ['-c', command] };
}

const literal = z
  .string()
  .max(32768)
  .refine((value) => !value.includes('\0') && !value.includes('${'));

export const taskCommand = z
  .object({
    command: literal.min(1),
    args: z.array(literal).max(256),
    cwd: literal.min(1),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), literal),
  })
  .refine(
    (value) =>
      Object.keys(value.env).length <= 64 && Buffer.byteLength(JSON.stringify(value)) <= 65536,
  );
