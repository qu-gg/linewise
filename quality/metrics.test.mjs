import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSource,
  compareBudgets,
  crapScore,
  functionCoverage,
  tightenBaseline,
} from './metrics-lib.mjs';
import { assertFreshCoverage } from './files.mjs';
import { retainAnonymousFunctions } from './coverage.mjs';

test('anonymous V8 function evidence survives reporting without inventing calls', () => {
  const functions = [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
    { functionName: '', ranges: [{ startOffset: 10, endOffset: 30, count: 4 }] },
    { functionName: '', ranges: [{ startOffset: 40, endOffset: 70, count: 0 }] },
  ];
  const report = { result: [{ url: 'file:///project/source.js', functions }] };
  const evidence = structuredClone(functions.map((current) => current.ranges));
  retainAnonymousFunctions(report, ['file:///project/']);
  assert.deepEqual(
    functions.map((current) => current.functionName),
    ['', '<anonymous>', '<anonymous>'],
  );
  assert.deepEqual(
    functions.map((current) => current.ranges),
    evidence,
  );
  assert.equal(
    functionCoverage(
      { line: 1, endLine: 3 },
      {
        fnMap: {
          0: {
            name: '<anonymous>',
            loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } },
          },
        },
        f: { 0: 0 },
        statementMap: {},
        s: {},
      },
    ),
    0,
  );
});

test('exported function coverage uses the exported declaration boundary', () => {
  const source = 'export function decide(value) { return value ? 1 : 0; }';
  const current = analyzeSource(source, 'fixture.js').functions[0];
  const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: source.length } };
  assert.equal(
    functionCoverage(current, {
      fnMap: { 0: { name: 'decide', loc } },
      f: { 0: 1 },
      statementMap: { 0: loc },
      s: { 0: 1 },
    }),
    100,
  );
});

test('changed sources, modified reports and another coverage profile are rejected', () => {
  const sources = { 'src/review.ts': 'digest' };
  const manifest = { version: 1, profile: 'unit', sources, coverageHash: 'report' };
  assert.doesNotThrow(() => assertFreshCoverage(manifest, sources, 'report'));
  assert.throws(
    () => assertFreshCoverage(manifest, { 'src/review.ts': 'changed' }, 'report'),
    /stale/,
  );
  assert.throws(() => assertFreshCoverage(manifest, sources, 'changed-report'), /stale/);
  assert.throws(
    () => assertFreshCoverage({ ...manifest, profile: 'native' }, sources, 'report'),
    /another profile/,
  );
});

test('known branch and nesting fixtures produce real McCabe, cognitive and Halstead scores', () => {
  const result = analyzeSource(
    'export function decide(value) { if (value) return 1; return 0; }',
    'fixture.js',
  );
  assert.equal(result.functions[0].cyclomatic, 2);
  assert.equal(result.functions[0].cognitive, 1);
  assert.equal(result.metrics.halsteadVolume, Number((9 * Math.log2(7)).toFixed(3)));
  const nested = analyzeSource(
    'function decide(first, second) { if(first) { if(second) return 1; } return 0; }',
    'fixture.js',
  );
  assert.equal(nested.functions[0].cyclomatic, 3);
  assert.equal(nested.functions[0].cognitive, 3);
});

test('TypeScript annotations, class methods and modern JavaScript remain measurable', () => {
  const result = analyzeSource(
    'class Example { run(input?: { value: number }): number { return input?.value ?? 0; } }',
    'fixture.ts',
  );
  assert.match(result.functions[0].name, /Example.run/);
  assert.equal(result.functions[0].cyclomatic, 3);
  assert.ok(result.metrics.halsteadVolume > 0);
  assert.ok(
    analyzeSource('const call = options => inspect({ ...options, enabled: true });', 'fixture.js')
      .metrics.halsteadVolume > 0,
  );
  const callbacks = analyzeSource(
    'function work() { return { create(context) { return {value: descriptor => descriptor}; } }; }',
    'fixture.js',
  );
  assert.equal(callbacks.functions.length, 3);
  assert.ok(callbacks.functions.every((current) => current.cyclomatic === 1));
  assert.throws(() => analyzeSource('function broken(', 'fixture.js'), /Parsing error/);
});

test('CRAP uses actual coverage fractions and refuses invalid values', () => {
  assert.equal(crapScore(10, 0), 110);
  assert.equal(crapScore(10, 100), 10);
  assert.equal(crapScore(10, 50), 22.5);
  assert.throws(() => crapScore(10, 101));
  assert.throws(() => crapScore(NaN, 50));
});

test('class-field arrow complexity maps to the field declaration without counting its initializer twice', () => {
  const result = analyzeSource(
    'class Example { private readonly decide = (value: boolean) => value ? 1 : 0; }',
    'fixture.ts',
  );
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].name, 'Example.decide#1');
  assert.equal(result.functions[0].cyclomatic, 2);
  assert.equal(result.functions[0].cognitive, 1);
});

test('missing or empty function coverage cannot masquerade as fully tested code', () => {
  const current = { line: 1, endLine: 3 };
  assert.throws(() => functionCoverage(current), /Missing/);
  assert.equal(functionCoverage(current, { fnMap: {}, f: {}, statementMap: {}, s: {} }), 0);
  const coverage = {
    fnMap: {
      0: { name: 'real', loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } },
    },
    f: { 0: 1 },
    statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } } },
    s: { 0: 1, 1: 0 },
  };
  assert.equal(functionCoverage(current, coverage), 50);
  assert.equal(functionCoverage({ line: 1, column: 30, endLine: 1, endColumn: 50 }, coverage), 0);
});

test('budgets reject new regressions, stale exemptions and attempts to weaken defaults', () => {
  const items = [{ id: 'fixture.js::work#1', metrics: { cyclomatic: 11 } }];
  const empty = { exceptions: {} };
  assert.equal(compareBudgets(items, empty).length, 1);
  const baseline = {
    exceptions: {
      'fixture.js::work#1': {
        max: { cyclomatic: 11 },
        reason: 'Existing debt; reduce this explicit budget during refactoring.',
      },
    },
  };
  assert.deepEqual(compareBudgets(items, baseline), []);
  assert.equal(compareBudgets([{ ...items[0], metrics: { cyclomatic: 12 } }], baseline).length, 1);
  assert.ok(compareBudgets([], baseline).some((message) => message.includes('stale')));
  assert.ok(
    compareBudgets([{ ...items[0], metrics: { cyclomatic: 5 } }], baseline).some((message) =>
      message.includes('obsolete'),
    ),
  );
  assert.throws(() =>
    compareBudgets(items, {
      exceptions: {
        'fixture.js::work#1': {
          max: { cyclomatic: 5 },
          reason: 'Do not permit a silent global-threshold change.',
        },
      },
    }),
  );
});

test('baseline tightening only retires debt, reduces maxima and raises coverage floors', () => {
  const reason = 'Existing measured debt must only decrease during this coverage pass.';
  const baseline = {
    version: 1,
    profile: 'unit',
    exceptions: {
      work: { reason, max: { cyclomatic: 20, crap: 100 } },
      deleted: { reason, max: { functionLines: 90 } },
    },
    coverageFloors: { 'src/work.ts': { min: 30, reason } },
  };
  const original = structuredClone(baseline);
  const items = [{ id: 'work', metrics: { cyclomatic: 12, crap: 12 } }];
  const files = [{ file: 'src/work.ts', lineCoverage: 91.237 }];
  const next = tightenBaseline(items, files, baseline);
  assert.deepEqual(next.exceptions, { work: { reason, max: { cyclomatic: 12 } } });
  assert.equal(next.coverageFloors['src/work.ts'].min, 91.23);
  assert.deepEqual(baseline, original);
  assert.throws(
    () => tightenBaseline([{ id: 'work', metrics: { cyclomatic: 21 } }], files, baseline),
    /regressed/,
  );
  assert.throws(
    () => tightenBaseline([{ id: 'new', metrics: { cyclomatic: 11 } }], files, baseline),
    /regressed/,
  );
  assert.throws(
    () => tightenBaseline(items, [{ file: 'src/work.ts', lineCoverage: 29 }], baseline),
    /regressed/,
  );
  assert.throws(
    () => tightenBaseline(items, [{ file: 'src/new.ts', lineCoverage: 79 }], baseline),
    /regressed/,
  );
});
