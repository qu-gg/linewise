import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/omp-version.ts', import.meta.url), 'utf8');

function text(name) {
  const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
  if (!match) throw new Error(`Missing ${name} in src/omp-version.ts.`);
  return match[1];
}

function number(name) {
  const match = source.match(new RegExp(`export const ${name} = (\\d+)`));
  if (!match) throw new Error(`Missing ${name} in src/omp-version.ts.`);
  return Number(match[1]);
}

export const OMP_TESTED_VERSION = text('OMP_TESTED_VERSION');
export const OMP_MINIMUM_VERSION = text('OMP_MINIMUM_VERSION');
export const OMP_MAJOR = number('OMP_MAJOR');
export const VSCODE_TESTED_VERSION = text('VSCODE_TESTED_VERSION');
