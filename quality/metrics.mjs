import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  analyzeSource,
  compareBudgets,
  crapScore,
  functionCoverage,
  limits,
  tightenBaseline,
} from './metrics-lib.mjs';
import {
  assertFreshCoverage,
  digest,
  isProduction,
  lineCoverage,
  sourceFiles,
  sourceManifest,
} from './files.mjs';

const baselinePath = 'quality/baseline.json';
const budgetSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal('unit'),
    exceptions: z.record(
      z.string(),
      z
        .object({
          reason: z.string().min(20),
          max: z.partialRecord(z.enum(Object.keys(limits)), z.number().finite().nonnegative()),
        })
        .strict(),
    ),
    coverageFloors: z.record(
      z.string(),
      z.object({ min: z.number().min(0).max(100), reason: z.string().min(20) }).strict(),
    ),
  })
  .strict();

function loadCoverage() {
  const text = readFileSync('reports/coverage/coverage-final.json', 'utf8');
  const manifest = JSON.parse(readFileSync('reports/coverage/manifest.json', 'utf8'));
  assertFreshCoverage(manifest, sourceManifest(), digest(text));
  return JSON.parse(text);
}

function measureFile(file, coverage) {
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.css'))
    return { file, metrics: { fileLines: source.trimEnd().split('\n').length }, functions: [] };
  let analysis;
  try {
    analysis = analyzeSource(source, file);
  } catch (cause) {
    throw new Error(`${file}: metric analysis failed.`, { cause });
  }
  const measured = { file, ...analysis };
  if (!isProduction(file)) return measured;
  const record = coverage[path.resolve(file)];
  if (!record) throw new Error(`${file}: production file omitted from coverage.`);
  measured.lineCoverage = lineCoverage(record);
  for (const current of measured.functions) {
    current.coverage = functionCoverage(current, record);
    current.crap = crapScore(current.cyclomatic, current.coverage);
  }
  return measured;
}

function budgetItems(files) {
  return files.flatMap((file) => [
    { id: file.file, metrics: file.metrics },
    ...file.functions.map((current) => ({
      id: `${file.file}::${current.name}`,
      metrics: {
        cyclomatic: current.cyclomatic,
        cognitive: current.cognitive,
        functionLines: current.functionLines,
        ...(current.crap === undefined ? {} : { crap: current.crap }),
      },
    })),
  ]);
}

function recordBaseline(files, items, reason) {
  if (process.env.CI) throw new Error('Baseline recording is forbidden in CI.');
  if (!reason || reason.trim().length < 20)
    throw new Error(
      'Baseline recording requires an explicit review reason of at least 20 characters.',
    );
  const exceptions = {};
  for (const item of items) {
    const max = Object.fromEntries(
      Object.entries(item.metrics).filter(([metric, value]) => value > limits[metric]),
    );
    if (Object.keys(max).length) exceptions[item.id] = { reason, max };
  }
  const coverageFloors = Object.fromEntries(
    files
      .filter((file) => isProduction(file.file))
      .map((file) => [file.file, { min: Math.floor(file.lineCoverage * 100) / 100, reason }]),
  );
  writeFileSync(
    baselinePath,
    JSON.stringify(
      budgetSchema.parse({ version: 1, profile: 'unit', exceptions, coverageFloors }),
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Recorded ${Object.keys(exceptions).length} explicit exceptions. Review this baseline; it is never refreshed by check/CI.`,
  );
}

function checkCoverage(files, baseline) {
  const production = files.filter((file) => isProduction(file.file));
  const failures = production
    .filter((file) => file.lineCoverage < (baseline.coverageFloors[file.file]?.min ?? 80))
    .map(
      (file) =>
        `${file.file}: line coverage ${file.lineCoverage.toFixed(2)}% is below ${baseline.coverageFloors[file.file]?.min ?? 80}%`,
    );
  for (const file of Object.keys(baseline.coverageFloors)) {
    if (!production.some((item) => item.file === file))
      failures.push(`${file}: stale coverage floor`);
  }
  return failures;
}

const coverage = loadCoverage();
const files = sourceFiles().map((file) => measureFile(file, coverage));
const items = budgetItems(files);
mkdirSync('reports/quality', { recursive: true });
writeFileSync(
  'reports/quality/metrics.json',
  JSON.stringify(
    {
      version: 1,
      profile: 'unit',
      halsteadProfile: 'TypeScript 6 type-erased ES2017 normalization; file-level metrics',
      defaults: limits,
      files,
    },
    null,
    2,
  ) + '\n',
);
if (process.argv[2] === '--record-baseline')
  recordBaseline(files, items, process.argv.slice(3).join(' '));
let baseline = budgetSchema.parse(JSON.parse(readFileSync(baselinePath, 'utf8')));
if (process.argv[2] === '--tighten-baseline') {
  if (process.env.CI) throw new Error('Baseline tightening is forbidden in CI.');
  baseline = budgetSchema.parse(tightenBaseline(items, files, baseline));
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log('Baseline tightened without accepting new metric debt or reducing coverage floors.');
}
const failures = [...compareBudgets(items, baseline), ...checkCoverage(files, baseline)];
console.log(
  `Measured ${files.length} files and ${files.reduce((total, file) => total + file.functions.length, 0)} functions. Full report: reports/quality/metrics.json`,
);
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
