import { z } from 'zod';

const pageId = z.uuid();
const selector = z.string().min(1).max(1024);
const address = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) URL without embedded credentials.');

export const browserRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pages') }).strict(),
  z.object({ action: z.literal('open'), url: address }).strict(),
  z.object({ action: z.literal('navigate'), pageId, url: address }).strict(),
  z.object({ action: z.literal('read'), pageId }).strict(),
  z.object({ action: z.literal('console'), pageId }).strict(),
  z.object({ action: z.literal('screenshot'), pageId }).strict(),
  z.object({ action: z.literal('close'), pageId }).strict(),
  z.object({ action: z.enum(['back', 'forward', 'reload']), pageId }).strict(),
  z.object({ action: z.enum(['click', 'hover']), pageId, selector }).strict(),
  z.object({ action: z.literal('fill'), pageId, selector, text: z.string().max(8000) }).strict(),
  z
    .object({
      action: z.literal('press'),
      pageId,
      selector,
      key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']),
    })
    .strict(),
  z
    .object({
      action: z.literal('select'),
      pageId,
      selector,
      values: z.array(z.string().max(200)).min(1).max(16),
    })
    .strict(),
  z
    .object({
      action: z.literal('viewport'),
      pageId,
      width: z.number().int().min(320).max(1920),
      height: z.number().int().min(240).max(1440),
    })
    .strict(),
]);

export type BrowserRequest = z.infer<typeof browserRequest>;

export function browserReason(input: unknown): string | undefined {
  return browserRequest.safeParse(input).success
    ? undefined
    : 'Unsupported or unbounded owned-browser request.';
}
