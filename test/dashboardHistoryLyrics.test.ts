import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGuildHistoryPayload,
  buildLyricsSearchQuery,
} from '../src/dashboard/historyLyrics.ts';
import type { Session, Track } from '../src/types/domain.ts';

test('buildLyricsSearchQuery prefers explicit query', () => {
  const session = {
    player: {
      currentTrack: { title: 'Song', artist: 'Artist', url: 'https://example.com' },
    },
  } as unknown as Session;

  assert.equal(buildLyricsSearchQuery(session, 'custom query'), 'custom query');
});

test('buildLyricsSearchQuery falls back to current track artist and title', () => {
  const session = {
    player: {
      currentTrack: { title: 'Song', artist: 'Artist', url: 'https://example.com' },
    },
  } as unknown as Session;

  assert.equal(buildLyricsSearchQuery(session, ''), 'Artist - Song');
});

test('buildGuildHistoryPayload uses live session history when available', async () => {
  const tracks: Track[] = [
    { title: 'Old', url: 'https://example.com/old', duration: '3:00', source: 'deezer' },
    { title: 'New', url: 'https://example.com/new', duration: '4:00', source: 'deezer' },
  ];
  const session = {
    player: {
      historyTracks: tracks,
    },
  } as unknown as Session;

  const payload = await buildGuildHistoryPayload({
    guildId: 'guild-1',
    page: 1,
    session,
    library: null,
  });

  assert.equal(payload.total, 2);
  assert.equal(payload.items[0]?.title, 'New');
  assert.equal(payload.items[1]?.title, 'Old');
});
