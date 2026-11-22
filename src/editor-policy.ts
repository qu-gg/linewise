import { z } from 'zod';

const target = z.string().min(1).max(4096);
const limit = z.number().int().min(1).max(100).default(50);
export const editorRequest = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('notebookImage'),
      path: target,
      cell: z.number().int().min(1).max(1_000_000),
      output: z.number().int().min(1).max(1_000_000),
      item: z.number().int().min(1).max(1_000_000),
    })
    .strict(),
  z.object({ action: z.literal('tasks'), limit }).strict(),
  z
    .object({
      action: z.literal('workspaceSymbols'),
      query: z
        .string()
        .min(1)
        .max(200)
        .regex(/\S/u)
        .refine(
          (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
          'Query must not contain control or format characters.',
        ),
      limit,
    })
    .strict(),
  z
    .object({
      action: z.literal('notebook'),
      path: target,
      startCell: z.number().int().min(1).max(1_000_000).default(1),
      limit,
    })
    .strict(),
  z
    .object({
      action: z.literal('semanticSearch'),
      backend: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/u),
      query: z
        .string()
        .min(1)
        .max(200)
        .regex(/\S/u)
        .refine(
          (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
          'Query must not contain control or format characters.',
        ),
      glob: target.default('**/*'),
      limit,
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      query: z.string().min(1).max(512),
      glob: target.default('**/*'),
      caseSensitive: z.boolean().default(true),
      limit,
    })
    .strict(),
  z.object({ action: z.literal('files'), glob: target, limit }).strict(),
  z.object({ action: z.literal('diagnostics'), path: target.optional(), limit }).strict(),
  z.object({ action: z.literal('symbols'), path: target, limit }).strict(),
  z
    .object({
      action: z.enum(['definitions', 'references']),
      path: target,
      line: z.number().int().min(1).max(1_000_000),
      column: z.number().int().min(1).max(1_000_000),
      limit,
    })
    .strict(),
]);
export type EditorRequest = z.infer<typeof editorRequest>;
