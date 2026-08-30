import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEnqueueQuery, parseLoopMode, runDashboardAction } from '../src/dashboard/actions.ts';
import type { Session, Track } from '../src/types/domain.ts';

test('parseEnqueueQuery rejects empty and oversized queries', () => {
  assert.equal(parseEnqueueQuery(''), null);
  assert.equal(parseEnqueueQuery('   '), null);
  assert.equal(parseEnqueueQuery('a'.repeat(501)), null);
  assert.equal(parseEnqueueQuery('valid query'), 'valid query');
});

test('runDashboardAction enqueue resolves tracks through the player', async () => {
  const addedTrack: Track = {
    title: 'Queued',
    url: 'https://example.com/queued',
    duration: '3:00',
    source: 'deezer',
  };

  const session = {
    settings: { dedupeEnabled: false },
    player: {
      enqueue: async (query: string, options?: { playNext?: boolean; requestedBy?: string | null }) => {
        assert.equal(query, 'test song');
        assert.equal(options?.requestedBy, 'user-1');
        assert.equal(options?.playNext, true);
        return [addedTrack];
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, {
    type: 'enqueue',
    query: 'test song',
    playNext: true,
    requestedBy: 'user-1',
  });

  assert.deepEqual(result, { ok: true, added: 1 });
});

test('runDashboardAction seek calls player.seekTo', async () => {
  let seekTarget = -1;
  const session = {
    player: {
      seekTo: (seconds: number) => {
        seekTarget = seconds;
        return seconds;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'seek', positionSec: 42 });
  assert.deepEqual(result, { ok: true });
  assert.equal(seekTarget, 42);
});

test('runDashboardAction seek rejects invalid seek targets', async () => {
  const session = {
    player: {
      seekTo: () => {
        throw new Error('invalid');
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'seek', positionSec: 9999 });
  assert.deepEqual(result, { ok: false });
});

test('runDashboardAction shuffle calls shuffleQueue', async () => {
  let shuffled = false;
  const session = {
    player: {
      shuffleQueue: () => {
        shuffled = true;
        return 3;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'shuffle' });
  assert.deepEqual(result, { ok: true });
  assert.equal(shuffled, true);
});

test('runDashboardAction loop sets loop mode', async () => {
  let mode = 'off';
  const session = {
    player: {
      setLoopMode: (next: string) => {
        mode = next;
        return next;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'loop', mode: 'track' });
  assert.deepEqual(result, { ok: true });
  assert.equal(mode, 'track');
});

test('runDashboardAction previous skips when already playing', async () => {
  let skipped = false;
  const session = {
    player: {
      playing: true,
      queuePreviousTrack: () => ({ title: 'Prev', url: 'https://example.com/prev' }),
      skip: () => {
        skipped = true;
        return true;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'previous' });
  assert.deepEqual(result, { ok: true });
  assert.equal(skipped, true);
});

test('runDashboardAction previous starts playback when idle', async () => {
  let played = false;
  const session = {
    player: {
      playing: false,
      queuePreviousTrack: () => ({ title: 'Prev', url: 'https://example.com/prev' }),
      play: async () => {
        played = true;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, { type: 'previous' });
  assert.deepEqual(result, { ok: true });
  assert.equal(played, true);
});

test('parseLoopMode accepts supported loop modes', () => {
  assert.equal(parseLoopMode('track'), 'track');
  assert.equal(parseLoopMode('QUEUE'), 'queue');
  assert.equal(parseLoopMode('off'), 'off');
  assert.equal(parseLoopMode('invalid'), null);
});

test('runDashboardAction starts playback when enqueueing into an idle player', async () => {
  let played = false;
  const session = {
    settings: { dedupeEnabled: false },
    player: {
      playing: false,
      currentTrack: null,
      enqueue: async () => [{ title: 'Queued' }],
      play: async () => { played = true; },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, {
    type: 'enqueue',
    query: 'test song',
    playNext: false,
    requestedBy: 'user-1',
  });

  assert.deepEqual(result, { ok: true, added: 1 });
  assert.equal(played, true);
});

test('runDashboardAction plays a history track immediately', async () => {
  const calls: string[] = [];
  const session = {
    player: {
      playing: true,
      enqueue: async (query: string, options: { playNext: boolean; dedupe: boolean }) => {
        calls.push(`enqueue:${query}:${options.playNext}:${options.dedupe}`);
        return [{ title: 'Played again' }];
      },
      skip: () => {
        calls.push('skip');
        return true;
      },
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, {
    type: 'playHistory',
    query: 'https://example.com/history-track',
    requestedBy: 'user-1',
  });

  assert.deepEqual(result, { ok: true, added: 1 });
  assert.deepEqual(calls, ['enqueue:https://example.com/history-track:true:false', 'skip']);
});

test('runDashboardAction clears the pending queue', async () => {
  let cleared = false;
  const session = {
    player: {
      clearQueue: () => {
        cleared = true;
        return 3;
      },
    },
  } as unknown as Session;

  assert.deepEqual(await runDashboardAction(session, { type: 'clear' }), { ok: true });
  assert.equal(cleared, true);
});

test('runDashboardAction applies the complete effect state', async () => {
  const applied: string[] = [];
  const session = {
    player: {
      setFilterPreset: (value: string) => applied.push(`filter:${value}`),
      setEqPreset: (value: string) => applied.push(`eq:${value}`),
      setTempoRatio: (value: number) => applied.push(`tempo:${value}`),
      setPitchSemitones: (value: number) => applied.push(`pitch:${value}`),
    },
  } as unknown as Session;

  const result = await runDashboardAction(session, {
    type: 'effects',
    filterPreset: 'soft',
    eqPreset: 'vocal',
    tempoRatio: 0.95,
    pitchSemitones: -1,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(applied, ['filter:soft', 'eq:vocal', 'tempo:0.95', 'pitch:-1']);
});
