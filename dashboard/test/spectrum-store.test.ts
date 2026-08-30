import test from 'node:test';
import assert from 'node:assert/strict';

import { SPECTRUM_BANDS, SpectrumStore } from '../src/lib/spectrum-store';

type Queued = { dueAt: number };

function fullFrame(value: number) {
  return Array.from({ length: SPECTRUM_BANDS }, () => value);
}

function queueOf(store: SpectrumStore): Queued[] {
  return (store as unknown as { queue: Queued[] }).queue;
}

function pushDueNow(store: SpectrumStore, value: number) {
  store.push(fullFrame(value));
  for (const frame of queueOf(store)) frame.dueAt = Date.now() - 1;
}

test('a burst of frames is spread evenly instead of firing at once', () => {
  const store = new SpectrumStore();
  store.push(fullFrame(10));
  store.push(fullFrame(20));
  store.push(fullFrame(30));

  const queue = queueOf(store);
  assert.equal(queue.length, 3);

  const first = queue[0]?.dueAt ?? 0;
  const gapOne = (queue[1]?.dueAt ?? 0) - first;
  const gapTwo = (queue[2]?.dueAt ?? 0) - (queue[1]?.dueAt ?? 0);

  assert(Math.abs(gapOne - 1000 / 30) < 1, `expected ~33ms spacing, got ${gapOne}`);
  assert(Math.abs(gapTwo - 1000 / 30) < 1, `expected ~33ms spacing, got ${gapTwo}`);
});

test('playout resyncs when the stream stalls and resumes', () => {
  const store = new SpectrumStore();
  store.push(fullFrame(10));
  const stale = queueOf(store)[0]?.dueAt ?? 0;

  (store as unknown as { nextDueAt: number }).nextDueAt = stale - 5_000;
  store.push(fullFrame(20));

  const queued = queueOf(store);
  const latest = queued[queued.length - 1]?.dueAt ?? 0;
  assert(latest >= Date.now(), 'a stale cursor must resync to the present');
});

test('levels rise quickly but without an instant jump', () => {
  const store = new SpectrumStore();
  pushDueNow(store, 255);

  store.advance(0.016);
  const afterOneFrame = store.read()[0] ?? 0;
  assert(afterOneFrame > 0.2, `expected a fast attack, got ${afterOneFrame}`);
  assert(afterOneFrame < 0.95, `expected interpolation rather than a hard jump, got ${afterOneFrame}`);

  for (let i = 0; i < 6; i += 1) {
    pushDueNow(store, 255);
    store.advance(0.02);
  }
  assert((store.read()[0] ?? 0) > 0.9, 'a steady stream should reach the target shortly after');
});

test('decay is exponential and clears once the stream goes quiet', () => {
  const store = new SpectrumStore();
  pushDueNow(store, 255);
  store.advance(0.3);
  assert((store.read()[0] ?? 0) > 0.9);

  pushDueNow(store, 0);
  store.advance(0.25);
  const level = store.read()[0] ?? 1;
  assert(level < 0.25, `expected fast decay, level was ${level}`);
  assert(level > 0.0001, `expected exponential decay, not a hard cut: ${level}`);
});

test('reset clears queued frames, levels and the playout cursor', () => {
  const store = new SpectrumStore();
  store.push(fullFrame(255));
  store.reset();

  assert.equal(queueOf(store).length, 0);
  assert.equal(store.read()[0], 0);
  assert.equal(store.active, false);
});

test('store reports activity only while frames arrive', () => {
  const store = new SpectrumStore();
  assert.equal(store.active, false);
  store.push(fullFrame(120));
  assert.equal(store.active, true);
});

test('a long burst keeps even spacing instead of collapsing', () => {
  const store = new SpectrumStore();
  for (let i = 0; i < 30; i += 1) store.push(fullFrame(100 + i));

  const queue = queueOf(store);
  assert.equal(queue.length, 30, 'every frame of the burst must be queued');

  for (let i = 1; i < queue.length; i += 1) {
    const gap = (queue[i]?.dueAt ?? 0) - (queue[i - 1]?.dueAt ?? 0);
    assert(
      Math.abs(gap - 1000 / 30) < 1,
      `frame ${i} broke the spacing with a ${gap}ms gap, the schedule collapsed`,
    );
  }

  const span = (queue[queue.length - 1]?.dueAt ?? 0) - (queue[0]?.dueAt ?? 0);
  assert(span > 900, `30 frames should span about a second of playout, got ${span}ms`);
});

test('a schedule that has fallen into the past resyncs', () => {
  const store = new SpectrumStore();
  store.push(fullFrame(10));
  (store as unknown as { nextDueAt: number }).nextDueAt = Date.now() - 3_000;
  store.push(fullFrame(20));

  const queue = queueOf(store);
  const latest = queue[queue.length - 1]?.dueAt ?? 0;
  assert(latest >= Date.now(), 'an overdue cursor must jump back to the present');
});

test('a runaway schedule far in the future resyncs', () => {
  const store = new SpectrumStore();
  store.push(fullFrame(10));
  (store as unknown as { nextDueAt: number }).nextDueAt = Date.now() + 30_000;
  store.push(fullFrame(20));

  const queue = queueOf(store);
  const latest = queue[queue.length - 1]?.dueAt ?? 0;
  assert(latest < Date.now() + 5_000, 'a runaway cursor must be pulled back');
});

test('bars ease down instead of freezing when frames stop arriving', () => {
  const store = new SpectrumStore();
  pushDueNow(store, 255);
  store.advance(0.05);
  const peak = store.read()[0] ?? 0;
  assert(peak > 0.5, `expected the bars to be up first, got ${peak}`);

  let previous = peak;
  let moved = 0;
  for (let i = 0; i < 20; i += 1) {
    store.advance(0.05);
    const current = store.read()[0] ?? 0;
    if (Math.abs(current - previous) > 0.0005) moved += 1;
    previous = current;
  }

  assert(moved >= 15, `bars should keep easing while starved, they moved on ${moved} of 20 frames`);
  assert(previous < peak, 'the level must fall rather than hold');
});
