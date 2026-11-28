import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewGeometry, scrollTopForOverview } from '../../media/review-overview.js';

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('overview geometry maps full-file hunks and the viewport proportionally', () => {
  const geometry = overviewGeometry(
    [
      { kind: 'added', top: 100, height: 40 },
      { kind: 'removed', top: 450, height: 1 },
    ],
    1000,
    250,
    200,
    3,
  );
  assert.deepEqual(geometry.markers, [
    { kind: 'added', top: 0.1, height: 0.04 },
    { kind: 'removed', top: 0.45, height: 0.003 },
  ]);
  assert.deepEqual(geometry.thumb, { top: 0.2, height: 0.25 });
});

test('overview geometry clamps short files, out-of-range markers and scroll', () => {
  const geometry = overviewGeometry(
    [
      { kind: 'added', top: 90, height: 20 },
      { kind: 'removed', top: 200, height: 20 },
      { kind: 'added', top: -5, height: 0 },
    ],
    100,
    500,
    999,
    2,
  );
  assert.equal(geometry.markers.length, 1);
  assert.equal(geometry.markers[0]!.kind, 'added');
  assert.equal(geometry.markers[0]!.top, 0.9);
  close(geometry.markers[0]!.height, 0.1);
  assert.deepEqual(geometry.thumb, { top: 0, height: 1 });
  assert.equal(scrollTopForOverview(0, 100, 500), 0);
  assert.equal(scrollTopForOverview(1, 100, 500), 0);
  assert.equal(scrollTopForOverview(0.5, 1000, 250), 375);
});

test('overview geometry keeps the minimum marker visible and handles empty totals', () => {
  const geometry = overviewGeometry(
    [{ kind: 'removed', top: 999_999, height: 1 }],
    1_000_000,
    100,
    0,
    2,
  );
  assert.equal(geometry.markers.length, 1);
  assert.equal(geometry.markers[0]!.top, 0.999999);
  close(geometry.markers[0]!.height, 0.000001);
  assert.deepEqual(overviewGeometry([], 0, 0, 0), {
    markers: [],
    thumb: { top: 0, height: 1 },
  });
});
