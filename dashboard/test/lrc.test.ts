import test from 'node:test';
import assert from 'node:assert/strict';

import { findActiveLineIndex, parseLrc } from '../src/lib/lrc';

test('parseLrc reads timestamps with hundredths', () => {
  const lines = parseLrc('[00:12.34]Erste Zeile\n[01:05.60]Zweite Zeile');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.text, 'Erste Zeile');
  assert(Math.abs((lines[0]?.timeSec ?? 0) - 12.34) < 0.001);
  assert(Math.abs((lines[1]?.timeSec ?? 0) - 65.6) < 0.001);
});

test('parseLrc expands repeated timestamps on one line', () => {
  const lines = parseLrc('[00:10.00][00:40.00]Refrain');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.timeSec, 10);
  assert.equal(lines[1]?.timeSec, 40);
  assert.equal(lines[1]?.text, 'Refrain');
});

test('parseLrc keeps empty interlude lines and skips metadata', () => {
  const lines = parseLrc('[ar:Artist]\n[00:03.00]\n[00:09.00]Text');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.text, '');
  assert.equal(lines[1]?.text, 'Text');
});

test('parseLrc sorts out-of-order lines', () => {
  const lines = parseLrc('[00:30.00]Spaeter\n[00:05.00]Frueher');
  assert.equal(lines[0]?.text, 'Frueher');
  assert.equal(lines[1]?.text, 'Spaeter');
});

test('parseLrc returns nothing for plain text', () => {
  assert.deepEqual(parseLrc('Nur normaler Text\nOhne Timestamps'), []);
  assert.deepEqual(parseLrc(null), []);
});

test('findActiveLineIndex tracks the current line', () => {
  const lines = parseLrc('[00:00.00]A\n[00:10.00]B\n[00:20.00]C');
  assert.equal(findActiveLineIndex(lines, -1), -1);
  assert.equal(findActiveLineIndex(lines, 0), 0);
  assert.equal(findActiveLineIndex(lines, 9.9), 0);
  assert.equal(findActiveLineIndex(lines, 10), 1);
  assert.equal(findActiveLineIndex(lines, 999), 2);
  assert.equal(findActiveLineIndex([], 5), -1);
});
