import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  OMP_MAJOR,
  OMP_MINIMUM_VERSION,
  OMP_TESTED_VERSION,
  VSCODE_TESTED_VERSION,
} from './version-policy.mjs';

const read = (file) => readFileSync(file, 'utf8');
const manifest = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.equal(OMP_MAJOR, Number(OMP_TESTED_VERSION.split('.')[0]));
assert.ok(
  OMP_MINIMUM_VERSION.localeCompare(OMP_TESTED_VERSION, undefined, { numeric: true }) <= 0,
  'OMP minimum must not exceed the tested version.',
);
assert.equal(manifest.engines.vscode, `^${VSCODE_TESTED_VERSION}`);
assert.equal(manifest.dependencies['@oh-my-pi/pi-natives'], OMP_TESTED_VERSION);
assert.ok(
  manifest.contributes.configuration.properties['omp.executablePath'].description.includes(
    `OMP ${OMP_TESTED_VERSION}`,
  ),
  `package.json omp.executablePath must name OMP ${OMP_TESTED_VERSION}.`,
);
assert.equal(lock.packages[''].dependencies['@oh-my-pi/pi-natives'], OMP_TESTED_VERSION);
for (const [name, entry] of Object.entries(lock.packages))
  if (name.startsWith('node_modules/@oh-my-pi/pi-natives'))
    assert.equal(entry.version, OMP_TESTED_VERSION, name);

const currentDocs = {
  'README.md': read('README.md'),
  'RELEASE.md': read('RELEASE.md'),
  'docs/development.md': read('docs/development.md'),
};
for (const [file, text] of Object.entries(currentDocs)) {
  const plain = text.replaceAll('*', '');
  assert.ok(
    plain.includes(`OMP ${OMP_TESTED_VERSION}`),
    `${file} must name OMP ${OMP_TESTED_VERSION}.`,
  );
  assert.ok(
    plain.includes(VSCODE_TESTED_VERSION),
    `${file} must name VS Code ${VSCODE_TESTED_VERSION}.`,
  );
}
assert.ok(read('README.md').includes(`omp/${OMP_TESTED_VERSION}`));
const changelog = read('CHANGELOG.md');
const currentNotes = changelog.split(`## ${manifest.version}`)[1]?.split('\n## ')[0] ?? '';
assert.ok(
  currentNotes.includes(`OMP ${OMP_TESTED_VERSION}`),
  `CHANGELOG.md ${manifest.version} must name OMP ${OMP_TESTED_VERSION}.`,
);

const hardcoded = [OMP_TESTED_VERSION, '18.21.0'];
for (const relative of readdirSync('src', { recursive: true })) {
  if (typeof relative !== 'string' || !relative.endsWith('.ts')) continue;
  const file = path.join('src', relative);
  if (file === path.join('src', 'omp-version.ts')) continue;
  const text = read(file);
  for (const version of hardcoded)
    assert.ok(
      !text.includes(version),
      `${file} must use src/omp-version.ts instead of ${version}.`,
    );
}

console.log(
  `Pinned versions consistent: OMP ${OMP_TESTED_VERSION} (minimum ${OMP_MINIMUM_VERSION}), VS Code ${VSCODE_TESTED_VERSION}.`,
);
