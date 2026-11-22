import { z } from 'zod';

export const actionTitle = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const position = z.number().int().min(1).max(1_000_000);
const target = z.string().min(1).max(4096);
export const codeActionRequest = z
  .object({
    action: z.enum(['list', 'apply']),
    path: target,
    line: position,
    column: position,
    endLine: position,
    endColumn: position,
    kind: z.enum([
      'quickfix',
      'refactor',
      'refactor.extract.function',
      'refactor.rewrite.export.default',
      'source.organizeImports',
      'source.fixAll',
    ]),
    title: actionTitle.nullable(),
    paths: z.array(target).min(1).max(8),
  })
  .strict()
  .refine((input) => (input.action === 'list') === (input.title === null))
  .refine(
    (input) =>
      input.endLine > input.line ||
      (input.endLine === input.line && input.endColumn >= input.column),
  );
export type CodeActionRequest = z.infer<typeof codeActionRequest>;
