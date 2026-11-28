import { z } from 'zod';

export const usageSchema = z.object({
  used: z.number().finite().nonnegative(),
  size: z.number().finite().positive(),
  cost: z
    .object({ amount: z.number().finite().nonnegative(), currency: z.string().min(1) })
    .optional(),
  stale: z.boolean().optional(),
});

export type Usage = z.infer<typeof usageSchema>;
