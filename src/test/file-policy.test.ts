import test from 'node:test';
import assert from 'node:assert/strict';
import { hasShebang, lineNumbersForRead, readLineRanges } from '../file-policy.js';

test('only a leading interpreter shebang is executable text', () => {
  assert.equal(hasShebang('#!/bin/sh\n'), true);
  assert.equal(hasShebang('const marker = "#!";\n'), false);
  assert.equal(hasShebang('#![allow(dead_code)]\nfn main() {}\n'), false);
});

test('read selectors expand into the requested provenance lines', () => {
  assert.equal(readLineRanges('file.txt'), undefined);
  assert.equal(readLineRanges('file.txt:raw'), undefined);
  assert.deepEqual(readLineRanges('file.txt:2-3'), [[2, 3]]);
  assert.deepEqual(readLineRanges('file.txt:1,4-5'), [
    [1, 1],
    [4, 5],
  ]);
  assert.deepEqual(lineNumbersForRead('file.txt', 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(lineNumbersForRead('file.txt:raw', 3), [1, 2, 3]);
  assert.deepEqual(lineNumbersForRead('file.txt:2-3', 5), [2, 3]);
  assert.deepEqual(lineNumbersForRead('file.txt:1,4-5', 5), [1, 4, 5]);
  assert.deepEqual(lineNumbersForRead('file.txt:3-9', 5), [3, 4, 5]);
  assert.deepEqual(lineNumbersForRead('file.txt', 0), []);
});
