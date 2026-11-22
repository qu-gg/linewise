import { createHash } from 'node:crypto';
import path from 'node:path';

export interface IndexedSource {
  path: string;
  text: string;
  fingerprint: string;
}

interface CapturedSource extends IndexedSource {
  digest: string;
  lines: number[];
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function lineOffsets(text: string) {
  const offsets = [0];
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1))
    offsets.push(offset + 1);
  return offsets;
}

function position(lines: readonly number[], offset: number) {
  let first = 0;
  let last = lines.length;
  while (first + 1 < last) {
    const middle = Math.floor((first + last) / 2);
    if (lines[middle]! <= offset) first = middle;
    else last = middle;
  }
  return { line: first + 1, column: offset - lines[first]! + 1 };
}

function capturedSource(source: IndexedSource, previous?: CapturedSource): CapturedSource {
  const hash = digest(source.text);
  if (previous?.digest === hash && previous.fingerprint === source.fingerprint) return previous;
  return { ...source, digest: hash, lines: lineOffsets(source.text) };
}

function capture(sources: readonly IndexedSource[], previous: readonly CapturedSource[]) {
  if (sources.length > 256) throw new Error('Index exceeds its 256-file limit.');
  const existing = new Map(previous.map((source) => [source.path, source]));
  let bytes = 0;
  const paths = new Set<string>();
  const ordered = [...sources].sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
  );
  return ordered.map((source) => {
    const size = Buffer.byteLength(source.text);
    bytes += size;
    if (
      !source.path ||
      path.isAbsolute(source.path) ||
      source.path.split('/').includes('..') ||
      paths.has(source.path) ||
      source.text.includes('\0') ||
      size > 1_048_576 ||
      bytes > 4_194_304
    )
      throw new Error('Index source violates path, text or byte limits.');
    paths.add(source.path);
    return capturedSource(source, existing.get(source.path));
  });
}

function hit(source: CapturedSource, offset: number, length: number, generation: number) {
  const start = position(source.lines, offset);
  const end = position(source.lines, offset + length);
  return {
    path: source.path,
    ...start,
    endLine: end.line,
    endColumn: end.column,
    preview: source.text.slice(Math.max(0, offset - 80), offset + Math.min(length, 80) + 160),
    sourceHash: source.digest,
    generation,
  };
}

function validateQuery(query: string, limit: number) {
  if (!query || query.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Index query exceeds literal-search limits.');
}

export class LexicalIndex {
  private sources: CapturedSource[] = [];
  private key = '';
  private generation = 0;
  private rootHash = '';

  update(root: string, sources: readonly IndexedSource[], signal: AbortSignal) {
    signal.throwIfAborted();
    const captured = capture(sources, this.sources);
    const key = digest(
      JSON.stringify([
        root,
        captured.map(({ path, fingerprint, digest }) => [path, fingerprint, digest]),
      ]),
    );
    signal.throwIfAborted();
    if (key !== this.key) {
      this.sources = captured;
      this.key = key;
      this.rootHash = digest(root);
      this.generation++;
    }
    return this.generation;
  }

  search(query: string, caseSensitive: boolean, limit: number) {
    validateQuery(query, limit);
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const items: ReturnType<typeof hit>[] = [];
    let limited = false;
    for (const source of this.sources) {
      for (const match of source.text.matchAll(new RegExp(pattern, caseSensitive ? 'gu' : 'giu'))) {
        const item = hit(source, match.index, match[0].length, this.generation);
        if (
          items.length === limit ||
          Buffer.byteLength(JSON.stringify([...items, item])) > 63_000
        ) {
          limited = true;
          break;
        }
        items.push(item);
      }
      if (limited) break;
    }
    return {
      items,
      limited,
      generation: this.generation,
      rootHash: this.rootHash,
      indexedFiles: this.sources.length,
      indexedBytes: this.sources.reduce(
        (bytes, source) => bytes + Buffer.byteLength(source.text),
        0,
      ),
      index: 'lexical' as const,
    };
  }
}
