import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cruise } from 'dependency-cruiser';
import { parse } from '@babel/parser';
import config from '../.dependency-cruiser.mjs';

const expectedTools = ['read', 'write', 'todo', 'retain', 'recall', 'memory_edit', 'edit', 'bash'];

export function journalImportViolations(source) {
  const body = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body;
  return body
    .filter(
      (node) => node.type === 'ImportDeclaration' && /^(node:)?fs(\/|$)/.test(node.source.value),
    )
    .filter(
      (node) =>
        node.source.value !== 'node:fs/promises' ||
        node.specifiers.some(
          (specifier) =>
            specifier.type !== 'ImportSpecifier' ||
            !['lstat', 'realpath'].includes(specifier.imported.name),
        ),
    )
    .map(() => 'journal-must-mutate-only-through-TextFiles');
}

export function toolPolicyViolations(source) {
  const body = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body;
  const declaration = body
    .filter((node) => node.type === 'VariableDeclaration')
    .flatMap((node) => node.declarations)
    .find((node) => node.id.name === 'allowedTools');
  const values = declaration?.init?.elements?.map((node) => node.value);
  return JSON.stringify(values) === JSON.stringify(expectedTools)
    ? []
    : ['unsafe-tool-policy-change'];
}

export async function inspectGraph() {
  const result = await cruise(['src', 'media'], {
    ...config.options,
    baseDir: process.cwd(),
    ruleSet: { forbidden: config.forbidden },
    validate: true,
    outputType: 'json',
  });
  const report = typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
  if (!Array.isArray(report.modules) || !Array.isArray(report.summary.violations))
    throw new Error('Invalid architecture analyzer output.');
  return report;
}

async function main() {
  const report = await inspectGraph();
  const policies = [
    ...journalImportViolations(readFileSync('src/review.ts', 'utf8')),
    ...toolPolicyViolations(readFileSync('src/omp-guard.ts', 'utf8')),
  ];
  mkdirSync('reports/quality', { recursive: true });
  writeFileSync(
    'reports/quality/architecture.json',
    JSON.stringify({ ...report, policies }, null, 2) + '\n',
  );
  const failures = [
    ...report.summary.violations.map((item) => `${item.rule.name}: ${item.from} -> ${item.to}`),
    ...policies,
  ];
  for (const failure of failures) console.error(failure);
  console.log(
    `Architecture: ${report.modules.length} modules, ${failures.length} violations. Report: reports/quality/architecture.json`,
  );
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
