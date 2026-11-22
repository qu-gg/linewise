import type { TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';

const diagnostic = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\p{Cc}\p{Cf}:?#]/u.test(value)),
    line: z.number().int().min(1).max(1000000),
    column: z.number().int().min(1).max(1000000),
    message: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => !/[\p{Cf}]/u.test(value) && !/\p{Cc}/u.test(value.replaceAll('\n', ''))),
    severity: z.enum(['error', 'warning']).default('error'),
  })
  .strict();

export type TaskDiagnostic = z.infer<typeof diagnostic>;

function diagnosticLine(line: string): TaskDiagnostic | false | undefined {
  if (!line.trimStart().startsWith('{')) return undefined;
  try {
    const parsed = diagnostic.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : false;
  } catch {
    return false;
  }
}

export function taskDiagnosticRows(outputs: readonly Partial<TerminalOutputResponse>[]) {
  const items: TaskDiagnostic[] = [];
  let ignored = 0;
  let limited = false;
  for (const output of outputs) {
    const text = output.output ?? '';
    if (Buffer.byteLength(text) > 65536) throw new Error('Task diagnostic output exceeds 64 KiB.');
    const lines = stripVTControlCharacters(text).split('\n');
    lines.pop();
    if (output.truncated) {
      lines.shift();
      limited = true;
    }
    limited ||= lines.length > 256;
    for (const line of lines.slice(0, 256)) {
      const parsed = diagnosticLine(line);
      if (parsed === undefined) continue;
      if (parsed === false) ignored++;
      else if (items.length >= 32) limited = true;
      else items.push(parsed);
    }
  }
  return { format: 'json-lines-v1', items, ignored, limited };
}

export function taskDiagnosticOffset(
  text: string,
  location: Pick<TaskDiagnostic, 'line' | 'column'>,
): number {
  if (Buffer.byteLength(text) > 1048576 || text.includes('\0'))
    throw new Error('Task diagnostic source is unavailable.');
  const lines = text.split('\n');
  const selected = lines[location.line - 1];
  if (selected === undefined || location.column > selected.replace(/\r$/, '').length + 1)
    throw new Error('Task diagnostic location is outside the current source.');
  return (
    lines.slice(0, location.line - 1).reduce((offset, line) => offset + line.length + 1, 0) +
    location.column -
    1
  );
}
