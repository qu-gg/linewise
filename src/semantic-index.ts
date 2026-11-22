import { createHash } from 'node:crypto';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import type { IndexedSource } from './search-index.js';

export const semanticBackend = 'local-lsa-v1';
const caseBoundary = /([a-z0-9])([A-Z])/gu;
const identifierPattern = /[\p{L}\p{N}]+/gu;
const carriageReturn = /\r$/u;
const stopWords = new Set(
  'export function const let return def if else for in from import and or not true false none number string boolean async await new throw class the a an to of at its by with then after as whether'.split(
    ' ',
  ),
);

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function terms(text: string) {
  const counts = new Map<string, number>();
  let limited = false;
  const separated = text.replace(caseBoundary, '$1 $2').toLowerCase();
  for (const match of separated.matchAll(identifierPattern)) {
    const word = match[0];
    if (stopWords.has(word)) continue;
    if (word.length > 128 || (!counts.has(word) && counts.size === 512)) {
      limited = true;
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return { counts, limited };
}

function capture(sources: readonly IndexedSource[]) {
  if (sources.length > 256) throw new Error('Semantic discovery exceeds 256 captured sources.');
  const ordered = [...sources].sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
  );
  const selected: (IndexedSource & { sourceHash: string })[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  let limited = sources.length > 64;
  for (const source of ordered.slice(0, 64)) {
    if (
      !source.path ||
      path.isAbsolute(source.path) ||
      source.path.split('/').includes('..') ||
      source.text.includes('\0') ||
      paths.has(source.path)
    )
      throw new Error('Semantic source violates root-owned text limits.');
    paths.add(source.path);
    bytes += Buffer.byteLength(source.text);
    if (bytes > 1_048_576) {
      limited = true;
      break;
    }
    selected.push({ ...source, sourceHash: hash(source.text) });
  }
  return { sources: selected, limited };
}

function normalize(values: number[]) {
  const norm = Math.hypot(...values);
  return values.map((value) => (norm === 0 ? 0 : value / norm));
}

function latentProjection(rows: number[][], dimensions: number) {
  const decomposition = new SingularValueDecomposition(new Matrix(rows), { autoTranspose: true });
  const projection = decomposition.rightSingularVectors;
  const width = Math.min(dimensions, projection.columns);
  return projection.subMatrix(0, projection.rows - 1, 0, width - 1).to2DArray();
}

function project(row: number[], projection: number[][]) {
  const result = new Array<number>(projection[0]?.length ?? 0).fill(0);
  for (let term = 0; term < row.length; term++)
    for (let dimension = 0; dimension < result.length; dimension++)
      result[dimension]! += row[term]! * projection[term]![dimension]!;
  return normalize(result);
}

async function vocabulary(sources: ReturnType<typeof capture>['sources'], signal: AbortSignal) {
  const words = new Map<string, number>();
  const documents: Map<string, number>[] = [];
  let limited = false;
  for (const source of sources) {
    signal.throwIfAborted();
    const document = terms(`${source.path}\n${source.text}`);
    documents.push(document.counts);
    limited ||= document.limited;
    for (const word of document.counts.keys()) {
      if (!words.has(word) && words.size === 512) {
        limited = true;
        continue;
      }
      words.set(word, (words.get(word) ?? 0) + 1);
    }
    await yieldTurn();
  }
  const names = [...words.keys()];
  const weights = names.map((word) => Math.log(1 + sources.length / (1 + words.get(word)!)));
  const rows = documents.map((document) =>
    normalize(
      names.map((word, index) => {
        const count = document.get(word) ?? 0;
        return count === 0 ? 0 : (1 + Math.log(count)) * weights[index]!;
      }),
    ),
  );
  return { names, weights, rows, limited };
}

function evidence(source: ReturnType<typeof capture>['sources'][number]) {
  const prefix = source.text.slice(0, 2000);
  const lines = prefix.split('\n').slice(0, 8);
  const last = lines[lines.length - 1]!.replace(carriageReturn, '');
  return {
    path: source.path,
    line: 1,
    column: 1,
    endLine: lines.length,
    endColumn: last.length + 1,
    preview: lines.join('\n'),
    sourceHash: source.sourceHash,
    relevance: 'file-level; preview is not an exact match',
  };
}

type Model = Awaited<ReturnType<typeof build>>;

async function build(
  selected: ReturnType<typeof capture>,
  signal: AbortSignal,
  decompose: typeof latentProjection,
) {
  const started = performance.now();
  const data = await vocabulary(selected.sources, signal);
  signal.throwIfAborted();
  const dimensions = Math.min(32, Math.max(2, Math.ceil(selected.sources.length / 2)));
  const projection = data.names.length === 0 ? [] : decompose(data.rows, dimensions);
  const vectors = data.rows.map((row) => project(row, projection));
  await yieldTurn();
  signal.throwIfAborted();
  if (performance.now() - started > 10000)
    throw new Error('Semantic build exceeds its ten-second budget.');
  const derivedBytes = Buffer.byteLength(JSON.stringify({ selected, data, projection, vectors }));
  if (derivedBytes > 16_777_216)
    throw new Error('Semantic snapshot exceeds 16 MiB derived storage.');
  return {
    ...data,
    ...selected,
    projection,
    vectors,
    limited: selected.limited || data.limited,
    derivedBytes,
  };
}

function ranked(model: Model, query: string, limit: number, generation: number) {
  if (!query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Semantic query exceeds its bounds.');
  const counts = terms(query).counts;
  const row = model.names.map((word, index) => {
    const count = counts.get(word) ?? 0;
    return count === 0 ? 0 : (1 + Math.log(count)) * model.weights[index]!;
  });
  const vector = project(normalize(row), model.projection);
  const rankedSources = model.vectors.map((document, index) => ({
    index,
    score: document.reduce((score, value, dimension) => score + value * vector[dimension]!, 0),
  }));
  rankedSources.sort((first, second) => second.score - first.score || first.index - second.index);
  const items = [];
  let limited = model.limited;
  for (const result of rankedSources.filter((item) => item.score > 1e-8)) {
    const item = { ...evidence(model.sources[result.index]!), score: result.score, generation };
    if (items.length === limit || Buffer.byteLength(JSON.stringify([...items, item])) > 63000) {
      limited = true;
      break;
    }
    items.push(item);
  }
  return { items, limited };
}

export class SemanticIndex {
  private cache?: { key: string; snapshot: ReturnType<SemanticIndex['snapshot']> };
  private generation = 0;

  constructor(private readonly decompose = latentProjection) {}

  private snapshot(root: string, model: Model, generation: number) {
    return Object.freeze({
      search: (query: string, limit: number) => ({
        ...ranked(model, query, limit, generation),
        generation,
        rootHash: hash(root),
        index: 'semantic',
        backend: semanticBackend,
        backendVersion: '1',
        library: 'ml-matrix@6.12.1',
        localOnly: true,
        inferenceRequests: 0,
        indexedFiles: model.sources.length,
        indexedBytes: model.sources.reduce(
          (size, source) => size + Buffer.byteLength(source.text),
          0,
        ),
        derivedBytes: model.derivedBytes,
        vocabulary: model.names.length,
        latentDimensions: model.projection[0]?.length ?? 0,
        untrusted: true,
      }),
    });
  }

  async prepare(root: string, sources: readonly IndexedSource[], signal: AbortSignal) {
    signal.throwIfAborted();
    const selected = capture(sources);
    const key = hash(JSON.stringify([root, selected]));
    if (this.cache?.key === key) return this.cache.snapshot;
    const model = await build(selected, signal, this.decompose);
    signal.throwIfAborted();
    const snapshot = this.snapshot(root, model, ++this.generation);
    this.cache = { key, snapshot };
    return snapshot;
  }
}
