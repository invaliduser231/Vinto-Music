import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBarGeometry } from '../src/lib/visualizer-geometry';

const BANDS = 24;
const GAP = 3;

test('a zero width canvas yields no geometry instead of negative values', () => {
  assert.equal(computeBarGeometry(0, BANDS, GAP), null);
});

test('negative and non finite widths are rejected', () => {
  assert.equal(computeBarGeometry(-120, BANDS, GAP), null);
  assert.equal(computeBarGeometry(Number.NaN, BANDS, GAP), null);
  assert.equal(computeBarGeometry(Number.POSITIVE_INFINITY, BANDS, GAP), null);
});

test('a width narrower than the combined gaps never produces a negative radius', () => {
  for (let width = 1; width <= 120; width += 1) {
    const geometry = computeBarGeometry(width, BANDS, GAP);
    if (!geometry) continue;
    assert(geometry.barWidth > 0, `bar width must stay positive at ${width}px`);
    assert(geometry.radius >= 0, `radius must never go negative at ${width}px`);
    assert(geometry.gap >= 0, `gap must never go negative at ${width}px`);
  }
});

test('bars and gaps fill the available width exactly', () => {
  const width = 640;
  const geometry = computeBarGeometry(width, BANDS, GAP);
  assert(geometry);
  const used = (geometry.barWidth * BANDS) + (geometry.gap * (BANDS - 1));
  assert(Math.abs(used - width) < 0.001, `expected the bars to fill ${width}, got ${used}`);
});

test('the gap collapses before the bars become invisible', () => {
  const geometry = computeBarGeometry(30, BANDS, GAP);
  assert(geometry);
  assert(geometry.barWidth >= 1, `bars should stay at least a pixel wide, got ${geometry.barWidth}`);
  assert(geometry.gap < GAP, 'the gap should shrink on a narrow canvas');
});

test('radius never exceeds half a bar', () => {
  for (const width of [40, 100, 300, 1200]) {
    const geometry = computeBarGeometry(width, BANDS, GAP);
    assert(geometry);
    assert(geometry.radius <= geometry.barWidth / 2 + 0.0001);
  }
});

test('a single band uses the full width', () => {
  const geometry = computeBarGeometry(200, 1, GAP);
  assert(geometry);
  assert.equal(geometry.barWidth, 200);
  assert.equal(geometry.gap, 3);
});
