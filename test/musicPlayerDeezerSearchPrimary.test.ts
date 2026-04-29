import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
    ...overrides,
  });
}

test('text search resolves from Deezer first when both YouTube and Deezer are available', async () => {
  const player = createPlayer();
  let deezerCalls = 0;
  let youtubeCalls = 0;

  player._searchDeezerTracks = async () => {
    deezerCalls += 1;
    return [
      player._buildTrack({
        title: 'Berlin',
        url: 'https://www.deezer.com/track/3135556',
        duration: 180,
        requestedBy: 'user-1',
        source: 'deezer-search-direct',
        deezerTrackId: '3135556',
      }),
    ];
  };
  player._searchYouTubeTracks = async () => {
    youtubeCalls += 1;
    return [
      player._buildTrack({
        title: 'Berlin (YouTube)',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        duration: 180,
        requestedBy: 'user-1',
        source: 'youtube-search',
      }),
    ];
  };

  const tracks = await player._resolveSearchTrack('kool savas berlin', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'deezer-search-direct');
  assert.equal(youtubeCalls, 0);
  assert.equal(deezerCalls, 1);
});

test('text search falls back to YouTube when Deezer search yields no results', async () => {
  const player = createPlayer();
  let deezerCalls = 0;
  let youtubeCalls = 0;

  player._searchDeezerTracks = async () => {
    deezerCalls += 1;
    return [];
  };
  player._searchYouTubeTracks = async () => {
    youtubeCalls += 1;
    return [
      player._buildTrack({
        title: 'Berlin (YouTube)',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        duration: 180,
        requestedBy: 'user-1',
        source: 'youtube-search',
      }),
    ];
  };

  const tracks = await player._resolveSearchTrack('kool savas berlin', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'youtube-search');
  assert.equal(deezerCalls, 1);
  assert.equal(youtubeCalls, 1);
});

test('text search keeps Deezer-first even when NodeLink is enabled', async () => {
  const player = createPlayer({
    nodeLinkEnabled: true,
    nodeLinkBaseUrl: 'http://nodelink:3000',
    nodeLinkPassword: 'secret',
  });
  let deezerCalls = 0;
  let nodeLinkCalls = 0;

  player._searchDeezerTracks = async () => {
    deezerCalls += 1;
    return [
      player._buildTrack({
        title: 'Berlin',
        url: 'https://www.deezer.com/track/3135556',
        duration: 180,
        requestedBy: 'user-1',
        source: 'deezer-search-direct',
        deezerTrackId: '3135556',
      }),
    ];
  };
  player._resolveNodeLinkTracks = async () => {
    nodeLinkCalls += 1;
    return [];
  };

  const tracks = await player._resolveSearchTrack('kool savas berlin', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'deezer-search-direct');
  assert.equal(deezerCalls, 1);
  assert.equal(nodeLinkCalls, 0);
});

test('searchCandidates keeps Deezer-first even when NodeLink is enabled', async () => {
  const player = createPlayer({
    nodeLinkEnabled: true,
    nodeLinkBaseUrl: 'http://nodelink:3000',
    nodeLinkPassword: 'secret',
  });
  let deezerCalls = 0;
  let nodeLinkCalls = 0;

  player._searchDeezerTracks = async () => {
    deezerCalls += 1;
    return [
      player._buildTrack({
        title: 'Berlin',
        url: 'https://www.deezer.com/track/3135556',
        duration: 180,
        requestedBy: 'user-1',
        source: 'deezer-search-direct',
        deezerTrackId: '3135556',
      }),
    ];
  };
  player._resolveNodeLinkTracks = async () => {
    nodeLinkCalls += 1;
    return [];
  };

  const tracks = await player.searchCandidates('kool savas berlin', 5, { requestedBy: 'user-1' });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'deezer-search-direct');
  assert.equal(deezerCalls, 1);
  assert.equal(nodeLinkCalls, 0);
});




