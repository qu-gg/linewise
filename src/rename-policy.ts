import { z } from 'zod';

const target = z.string().min(1).max(4096);
export const renameRequest = z
  .object({
    path: target,
    line: z.number().int().min(1).max(1_000_000),
    column: z.number().int().min(1).max(1_000_000),
    newName: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\s\p{Cc}]/u.test(value)),
    paths: z.array(target).min(1).max(8),
  })
  .strict();
export type RenameRequest = z.infer<typeof renameRequest>;
