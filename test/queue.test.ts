import test from 'node:test';
import assert from 'node:assert/strict';

import { Queue } from '../src/player/Queue.ts';

function track(id: number) {
  return { id, title: `Track ${id}` };
}

test('queue basic next/current behavior', () => {
  const queue = new Queue();
  queue.add(track(1));
  queue.add(track(2));

  assert.equal(queue.pendingSize, 2);

  const first = queue.next();
  assert.ok(first);
  assert.ok(queue.current);
  assert.equal(first.id, 1);
  assert.equal(queue.current.id, 1);
  assert.equal(queue.pendingSize, 1);
});

test('queue remove removes pending index', () => {
  const queue = new Queue();
  queue.add(track(1));
  queue.add(track(2));
  queue.add(track(3));

  const removed = queue.remove(2);
  assert.ok(removed);
  assert.equal(removed.id, 2);
  assert.equal(queue.pendingSize, 2);
  assert.ok(queue.tracks[0]);
  assert.ok(queue.tracks[1]);
  assert.equal(queue.tracks[0].id, 1);
  assert.equal(queue.tracks[1].id, 3);
});

test('queue requeue current front/back', () => {
  const queue = new Queue();
  queue.add(track(1));
  queue.add(track(2));
  queue.next();

  queue.requeueCurrentBack();
  assert.equal(queue.pendingSize, 2);
  assert.ok(queue.tracks[1]);
  assert.equal(queue.tracks[1].id, 1);

  queue.requeueCurrentFront();
  assert.equal(queue.pendingSize, 3);
  assert.ok(queue.tracks[0]);
  assert.equal(queue.tracks[0].id, 1);
});

test('queue move reorders pending tracks with one-based indexes', () => {
  const queue = new Queue<{ title: string }>();
  queue.add({ title: 'A' });
  queue.add({ title: 'B' });
  queue.add({ title: 'C' });

  assert.equal(queue.move(3, 1), true);
  assert.deepEqual(queue.tracks.map((track) => track.title), ['C', 'A', 'B']);
  assert.equal(queue.move(0, 2), false);
  assert.equal(queue.move(1, 4), false);
});





