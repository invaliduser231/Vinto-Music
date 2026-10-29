import test from 'node:test';
import assert from 'node:assert/strict';

import { Queue } from '../src/player/Queue.ts';
import { queueLifecycleMethods } from '../src/player/musicPlayer/queueLifecycleMethods.ts';

function createPlayer(trackCount: number, playing = true) {
  const queue = new Queue<{ id: number; title: string }>();
  for (let id = 1; id <= trackCount; id += 1) queue.add({ id, title: `Track ${id}` });
  const calls = { skip: 0, prefetch: 0 };
  return {
    calls,
    player: {
      playing,
      queue,
      skip() {
        calls.skip += 1;
        return true;
      },
      _scheduleNextTrackPrefetch() {
        calls.prefetch += 1;
      },
    },
  };
}

test('skipToQueueIndex drops earlier tracks and skips the current one', () => {
  const { player, calls } = createPlayer(5);

  const target = queueLifecycleMethods.skipToQueueIndex.call(player as never, 3) as { id: number } | null;

  assert.equal(target?.id, 3);
  assert.deepEqual(player.queue.tracks.map((item) => item.id), [3, 4, 5]);
  assert.equal(calls.skip, 1);
});

test('skipToQueueIndex rejects out-of-range indexes and idle players', () => {
  const { player, calls } = createPlayer(2);
  assert.equal(queueLifecycleMethods.skipToQueueIndex.call(player as never, 3), null);
  assert.equal(queueLifecycleMethods.skipToQueueIndex.call(player as never, 0), null);

  const idle = createPlayer(2, false);
  assert.equal(queueLifecycleMethods.skipToQueueIndex.call(idle.player as never, 1), null);

  assert.equal(calls.skip, 0);
  assert.equal(player.queue.pendingSize, 2);
});

test('removeRangeFromQueue schedules a prefetch only when tracks were removed', () => {
  const { player, calls } = createPlayer(4);

  const removed = queueLifecycleMethods.removeRangeFromQueue.call(player as never, 2, 3) as unknown as Array<{ id: number }>;
  assert.deepEqual(removed.map((item) => item.id), [2, 3]);
  assert.equal(calls.prefetch, 1);

  queueLifecycleMethods.removeRangeFromQueue.call(player as never, 5, 6);
  assert.equal(calls.prefetch, 1);
});
