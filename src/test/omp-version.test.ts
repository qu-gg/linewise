import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OMP_MAJOR,
  OMP_TESTED_VERSION,
  ompVersionRequirement,
  parseOmpVersion,
  supportsOmpVersion,
} from '../omp-version.js';

test('OMP runtime policy accepts the tested line and newer minor releases', () => {
  assert.equal(parseOmpVersion(`omp/${OMP_TESTED_VERSION}`), OMP_TESTED_VERSION);
  assert.equal(parseOmpVersion(`OMP ${OMP_TESTED_VERSION} extra`), OMP_TESTED_VERSION);
  assert.equal(parseOmpVersion('no version'), undefined);
  assert.equal(supportsOmpVersion(`omp/${OMP_TESTED_VERSION}`), true);
  assert.equal(supportsOmpVersion(`omp/${OMP_MAJOR}.999.0`), true);
  assert.equal(supportsOmpVersion(`omp/${OMP_MAJOR - 1}.21.0`), false);
  assert.equal(supportsOmpVersion(`omp/${OMP_MAJOR}.0.0`), false);
  assert.equal(supportsOmpVersion(`omp/${OMP_MAJOR + 1}.0.0`), false);
  assert.match(ompVersionRequirement(), new RegExp(`OMP ${OMP_TESTED_VERSION} or newer`));
});
