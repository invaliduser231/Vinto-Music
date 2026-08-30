import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardQueueCsv } from '../src/lib/queue-export';
import type { QueueTrack } from '../src/types/session';

test('dashboard queue CSV escapes track fields and preserves order', () => {
  const queue = [{
    id: '1',
    title: 'Song, "Live"',
    artist: 'Artist',
    durationSec: 180,
    source: 'youtube',
    thumbnailUrl: null,
    requestedBy: 'user-1',
    requestedByName: 'Listener',
    requestedByAvatarUrl: null,
  }] satisfies QueueTrack[];

  const csv = buildDashboardQueueCsv(null, queue);

  assert.match(csv, /^position,title,artist/);
  assert.match(csv, /1,"Song, ""Live""",Artist,180/);
});
