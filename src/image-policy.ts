import { z } from 'zod';

const mime = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type ImagePayload = { mimeType: z.infer<typeof mime>; data: string };

export function imagePayload(mimeType: string, value: Uint8Array): ImagePayload {
  const type = mime.parse(mimeType);
  if (!value.byteLength || value.byteLength > 524_288)
    throw new Error('Image snapshot must contain at most 512 KiB.');
  const bytes = Buffer.from(value);
  const signatures = {
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    'image/webp':
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!signatures[type]) throw new Error('Image snapshot signature does not match its MIME.');
  return { mimeType: type, data: bytes.toString('base64') };
}

export function decodeImage(payload: ImagePayload): Buffer {
  if (typeof payload.data !== 'string' || payload.data.length > 699_052)
    throw new Error('Image snapshot exceeds its encoded limit.');
  const bytes = Buffer.from(payload.data, 'base64');
  if (bytes.toString('base64') !== payload.data)
    throw new Error('Image snapshot requires canonical base64.');
  imagePayload(payload.mimeType, bytes);
  return bytes;
}

export const imageSchema = z
  .object({ mimeType: mime, data: z.string().max(699_052) })
  .strict()
  .refine((value) => {
    try {
      decodeImage(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid bounded image snapshot.');
