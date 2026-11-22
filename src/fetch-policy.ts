import { z } from 'zod';

export const fetchRequest = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !/[\p{Cc}\p{Cf}]/u.test(value) &&
            url.href.length <= 4096
          );
        } catch {
          return false;
        }
      }, 'Use a bounded HTTP(S) URL without embedded credentials or control characters.'),
  })
  .strict();

export type FetchRequest = z.infer<typeof fetchRequest>;
