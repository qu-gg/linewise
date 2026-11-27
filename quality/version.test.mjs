import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeVersions } from '../scripts/release-accept.mjs';
import { OMP_TESTED_VERSION, VSCODE_TESTED_VERSION } from '../scripts/version-policy.mjs';

test('release runtime identity accepts the exact tested OMP CLI and refuses other output', () => {
  assert.deepEqual(validateRuntimeVersions(VSCODE_TESTED_VERSION, `omp/${OMP_TESTED_VERSION}`), {
    vscode: VSCODE_TESTED_VERSION,
    omp: OMP_TESTED_VERSION,
  });
  const [major, minor, patch] = OMP_TESTED_VERSION.split('.').map(Number);
  for (const output of [
    '',
    OMP_TESTED_VERSION,
    `other/${OMP_TESTED_VERSION}`,
    `omp/${major}.${minor}.${patch + 1}`,
    `omp/${major}.${minor + 1}.${patch}`,
    `omp/${OMP_TESTED_VERSION} extra`,
  ]) {
    assert.throws(() => validateRuntimeVersions(VSCODE_TESTED_VERSION, output));
  }
  assert.throws(() => validateRuntimeVersions('', `omp/${OMP_TESTED_VERSION}`));
  assert.throws(() => validateRuntimeVersions('1.147.1', `omp/${OMP_TESTED_VERSION}`));
});
