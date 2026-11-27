import { z } from 'zod';

/**
 * Per-turn stream timing collected from agent text chunks only.
 *
 * TTFT is measured from the prompt send time ({@link markPromptSent}) to the
 * first agent text chunk. Decode time only accumulates between adjacent text
 * chunks: a thought, tool, or plan update pauses the stream, so those phases
 * are never divided into decode throughput.
 */
export const streamMetrics = z.object({
  promptSentAt: z.number().finite().nonnegative().optional(),
  firstTextAt: z.number().finite().nonnegative().optional(),
  lastTextAt: z.number().finite().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(),
  decodeMs: z.number().finite().nonnegative().optional(),
  textActive: z.boolean().optional(),
});

export type StreamMetrics = z.infer<typeof streamMetrics>;

/** Output tokens are approximated from characters; never provider-reported. */
export const estimatedCharactersPerToken = 4;

export interface StreamTurn {
  status?: string;
  stream?: StreamMetrics;
}

export interface ObservedThroughput {
  tokensPerSecond: number;
  ttftMs?: number;
  characters: number;
  stale: boolean;
}

export function markPromptSent(current: { stream?: StreamMetrics }, at = Date.now()): void {
  current.stream = { ...current.stream, promptSentAt: at };
}

/** A thought, tool, or plan update ends the contiguous text run. */
export function pauseTextStream(current: { stream?: StreamMetrics }): void {
  const metrics = current.stream;
  if (metrics?.textActive) metrics.textActive = false;
}

export function recordChunkMetrics(
  current: { stream?: StreamMetrics },
  kind: 'text' | 'thought',
  text: string,
  receivedAt?: number,
): void {
  if (kind === 'text') {
    const at = receivedAt === undefined ? Date.now() : receivedAt;
    current.stream = recordTextOutput(current.stream, text, at);
    return;
  }
  pauseTextStream(current);
}

export function recordTextOutput(
  metrics: StreamMetrics | undefined,
  text: string,
  receivedAt: number,
): StreamMetrics | undefined {
  if (!text || !Number.isFinite(receivedAt)) return metrics;
  const current = metrics ?? {};
  const continues = current.textActive === true && Number.isFinite(current.lastTextAt);
  const previousGap = continues ? Math.max(0, receivedAt - (current.lastTextAt ?? receivedAt)) : 0;
  return {
    ...current,
    firstTextAt: current.firstTextAt ?? receivedAt,
    lastTextAt: receivedAt,
    characters: (current.characters ?? 0) + text.length,
    decodeMs: (current.decodeMs ?? 0) + previousGap,
    textActive: true,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function decodeRate(characters: number, decodeMs: number): number | undefined {
  const tokensPerSecond = characters / estimatedCharactersPerToken / (decodeMs / 1000);
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : undefined;
}

function firstTextDelay(sent: number | undefined, first: number): number | undefined {
  if (!finite(sent) || sent < 0 || first < sent) return undefined;
  return Math.round(first - sent);
}

function decodeSummary(
  metrics: StreamMetrics | undefined,
): Pick<ObservedThroughput, 'tokensPerSecond' | 'ttftMs' | 'characters'> | undefined {
  if (!metrics) return undefined;
  const first = metrics.firstTextAt;
  const last = metrics.lastTextAt;
  const characters = metrics.characters;
  const decodeMs = metrics.decodeMs;
  if (!finite(first) || !finite(last) || !finite(characters) || !finite(decodeMs)) return undefined;
  if (characters <= 0 || decodeMs <= 0) return undefined;
  const tokensPerSecond = decodeRate(characters, decodeMs);
  if (tokensPerSecond === undefined) return undefined;
  return { tokensPerSecond, ttftMs: firstTextDelay(metrics.promptSentAt, first), characters };
}

export function observedThroughput(turn: StreamTurn): ObservedThroughput | undefined {
  const summary = decodeSummary(turn.stream);
  if (!summary) return undefined;
  return { ...summary, stale: turn.status !== 'running' };
}
