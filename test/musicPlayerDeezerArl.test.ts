import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

function createPlayer() {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
  });
}

test('deezer resolver prefers direct ARL track resolver when configured', async () => {
  const player = createPlayer();
  let directCalled = false;

  player._resolveDeezerTrackDirect = async () => {
    directCalled = true;
    return [
      player._buildTrack({
        title: 'Deezer Direct',
        url: 'https://www.deezer.com/track/3135556',
        duration: 120,
        source: 'deezer-direct',
        requestedBy: 'user-1',
        deezerTrackId: '3135556',
      }),
    ];
  };

  const tracks = await player._resolveDeezerTrack('https://www.deezer.com/track/3135556', 'user-1');
  assert.equal(directCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'deezer-direct');
});

test('play() uses deezer pipeline for deezer-direct source tracks', async () => {
  const player = createPlayer();
  let deezerPipelineCalled = false;

  player._startDeezerPipeline = async () => {
    deezerPipelineCalled = true;
    player.ffmpeg = {
      stdout: {},
      once() {},
    };
  };
  player._startYouTubePipeline = async () => {
    throw new Error('youtube pipeline should not be used');
  };
  player._startPlayDlPipeline = async () => {
    throw new Error('play-dl pipeline should not be used');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Deezer Direct',
      url: 'https://www.deezer.com/track/3135556',
      duration: 180,
      source: 'deezer-direct',
      requestedBy: 'user-1',
      deezerTrackId: '3135556',
    }),
  ]);

  await player.play();
  assert.equal(deezerPipelineCalled, true);
});

test('play() uses deezer pipeline when deezerTrackId exists even if source is not deezer-direct', async () => {
  const player = createPlayer();
  let deezerPipelineCalled = false;

  player._startDeezerPipeline = async () => {
    deezerPipelineCalled = true;
    player.ffmpeg = {
      stdout: {},
      once() {},
    };
  };
  player._startYouTubePipeline = async () => {
    throw new Error('youtube pipeline should not be used');
  };
  player._startPlayDlPipeline = async () => {
    throw new Error('play-dl pipeline should not be used');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Berlin',
      url: 'https://www.deezer.com/track/3135556',
      duration: 180,
      source: 'spotify-oembed-deezer-search',
      requestedBy: 'user-1',
      deezerTrackId: '3135556',
    }),
  ]);

  await player.play();
  assert.equal(deezerPipelineCalled, true);
});

test('play() routes deezer URLs to the deezer pipeline even without a deezerTrackId', async () => {
  const player = createPlayer();
  let deezerPipelineCalled = false;

  player._startDeezerPipeline = async () => {
    deezerPipelineCalled = true;
    player.ffmpeg = {
      stdout: {},
      once() {},
    };
  };
  player._startYouTubePipeline = async () => {
    throw new Error('youtube pipeline should not be used');
  };
  player._startPlayDlPipeline = async () => {
    throw new Error('play-dl cannot stream Deezer and should not be used');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Are You That Somebody?',
      url: 'https://www.deezer.com/track/3135556',
      duration: 180,
      source: 'deezer',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();
  assert.equal(deezerPipelineCalled, true);
});

test('_resolveDeezerStreamUrl recovers the track id from a deezer URL when missing', async () => {
  const player = createPlayer();
  let resolvedWithTrackId = null;

  player._resolveDeezerFullStreamUrlWithArl = async (trackId) => {
    resolvedWithTrackId = trackId;
    return 'https://example.com/stream';
  };

  const typedPlayer = player as unknown as {
    _resolveDeezerStreamUrl: (track: unknown) => Promise<{ url: string; trackId: string }>;
  };
  const stream = await typedPlayer._resolveDeezerStreamUrl({
    url: 'https://www.deezer.com/track/3135556',
  });
  assert.equal(resolvedWithTrackId, '3135556');
  assert.equal(stream.url, 'https://example.com/stream');
  assert.equal(stream.trackId, '3135556');
});

test('_resolveStartupMirrorFallbackTrack mirrors a failed deezer track to a YouTube result', async () => {
  const player = createPlayer();
  let capturedQuery = '';

  player._searchYouTubeTracks = async (query: string, _limit: number, requestedBy: string | null) => {
    capturedQuery = String(query ?? '');
    return [
      player._buildTrack({
        title: 'Are You That Somebody?',
        url: 'https://www.youtube.com/watch?v=abc123',
        duration: 180,
        source: 'youtube-search',
        requestedBy,
      }),
    ];
  };

  const mirror = await player._resolveStartupMirrorFallbackTrack({
    title: 'Are You That Somebody?',
    artist: 'Aaliyah',
    duration: '3:00',
    source: 'deezer',
    url: 'https://www.deezer.com/track/3380594201',
  }, 'user-1');

  assert.ok(mirror);
  assert.equal(mirror?.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(mirror?.source, 'youtube-search');
  assert.equal(capturedQuery, 'Aaliyah - Are You That Somebody?');
});

test('_resolveStartupMirrorFallbackTrack returns null when YouTube search is disabled', async () => {
  const player = new MusicPlayer({ async sendAudio() {} }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
    enableYtSearch: false,
  });
  player._resolveCrossSourceToYouTube = async () => {
    throw new Error('should not be called when YouTube search is disabled');
  };

  const mirror = await player._resolveStartupMirrorFallbackTrack({
    title: 'Are You That Somebody?',
    source: 'deezer',
  }, 'user-1');
  assert.equal(mirror, null);
});





