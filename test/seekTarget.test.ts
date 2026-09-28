import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSeekTargetSeconds } from '../src/bot/commands/helpers/formatting.ts';

test('plain numbers and clock notation keep their meaning', () => {
  assert.equal(parseSeekTargetSeconds('3600'), 3600);
  assert.equal(parseSeekTargetSeconds('0'), 0);
  assert.equal(parseSeekTargetSeconds('1:30'), 90);
  assert.equal(parseSeekTargetSeconds('1:02:03'), 3723);
});

test('unit suffixes are applied instead of being dropped', () => {
  assert.equal(parseSeekTargetSeconds('1h'), 3600);
  assert.equal(parseSeekTargetSeconds('60m'), 3600);
  assert.equal(parseSeekTargetSeconds('90s'), 90);
  assert.equal(parseSeekTargetSeconds('1h30m'), 5400);
  assert.equal(parseSeekTargetSeconds('1h 30m 10s'), 5410);
  assert.equal(parseSeekTargetSeconds('1.5h'), 5400);
  assert.equal(parseSeekTargetSeconds('2M'), 120);
});

test('ambiguous or broken input is rejected rather than truncated', () => {
  assert.equal(parseSeekTargetSeconds('12abc'), null);
  assert.equal(parseSeekTargetSeconds('1x'), null);
  assert.equal(parseSeekTargetSeconds('1h1h'), null);
  assert.equal(parseSeekTargetSeconds('h'), null);
  assert.equal(parseSeekTargetSeconds('-5'), null);
  assert.equal(parseSeekTargetSeconds('1:2:3:4'), null);
  assert.equal(parseSeekTargetSeconds(''), null);
  assert.equal(parseSeekTargetSeconds(null), null);
});
