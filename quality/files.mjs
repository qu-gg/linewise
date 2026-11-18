import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';

export function sourceFiles() {
  return [
    ...globSync(['src/**/*.ts', 'media/*.{js,css}', 'scripts/*.mjs', 'quality/*.mjs', '*.mjs']),
  ].sort();
}

export function isProduction(file) {
  return /^src\/(?!test\/).+\.ts$/.test(file) || /^media\/.+\.js$/.test(file);
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sourceManifest() {
  return Object.fromEntries(
    sourceFiles()
      .filter(isProduction)
      .map((file) => [file, digest(readFileSync(file))]),
  );
}

export function assertFreshCoverage(manifest, sources, coverageHash) {
  if (
    manifest.version !== 1 ||
    manifest.profile !== 'unit' ||
    JSON.stringify(manifest.sources) !== JSON.stringify(sources) ||
    manifest.coverageHash !== coverageHash
  ) {
    throw new Error(
      'Coverage is missing, stale or from another profile. Run the coverage check first.',
    );
  }
}

export function lineCoverage(coverage) {
  const lines = new Map();
  for (const [id, statement] of Object.entries(coverage.statementMap)) {
    if (!Number.isFinite(coverage.s[id])) throw new Error('Invalid statement coverage.');
    const line = statement.start.line;
    lines.set(line, Math.max(lines.get(line) ?? 0, coverage.s[id]));
  }
  return lines.size
    ? ([...lines.values()].filter((count) => count > 0).length / lines.size) * 100
    : 0;
}
