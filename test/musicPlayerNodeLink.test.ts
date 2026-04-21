import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';
import type { NodeLinkLoadResult } from '../src/player/musicPlayer/NodeLinkClient.ts';
import type { Track } from '../src/types/domain.ts';

function createPlayer(options: ConstructorParameters<typeof MusicPlayer>[1] = {}) {
  return new MusicPlayer({
    connected: true,
    channelId: 'voice-1',
    async sendAudio() {},
  }, {
    nodeLinkEnabled: true,
    nodeLinkBaseUrl: 'http://nodelink:3000',
    nodeLinkPassword: 'secret',
    maxPlaylistTracks: 100,
    ...options,
  });
}

function nodeLinkTrack(title: string, encoded: string, sourceName = 'soundcloud') {
  return {
    encoded,
    info: {
      identifier: `${title}-id`,
      title,
      author: 'Artist',
      length: 123000,
      isSeekable: true,
      isStream: false,
      uri: `https://example.com/${encodeURIComponent(title)}`,
      artworkUrl: 'https://example.com/art.jpg',
      sourceName,
    },
  };
}

test('NodeLink load result mapping preserves encoded tracks and playlist limits', () => {
  const player = createPlayer();
  const result: NodeLinkLoadResult = {
    loadType: 'playlist',
    data: {
      tracks: [
        nodeLinkTrack('One', 'encoded-one'),
        nodeLinkTrack('Two', 'encoded-two'),
        nodeLinkTrack('Three', 'encoded-three'),
      ],
    },
  };

  const tracks = player._nodeLinkLoadResultToTracks(result, 'user-1', 2);

  assert.equal(tracks.length, 2);
  assert.equal(tracks[0]!.title, 'One');
  assert.equal(tracks[0]!.duration, '2:03');
  assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-one');
  assert.equal(tracks[0]!.nodelinkInfo?.sourceName, 'soundcloud');
  assert.equal(tracks[1]!.nodelinkEncodedTrack, 'encoded-two');
});

test('NodeLink load result mapping skips non-playable YouTube channel URLs', () => {
  const player = createPlayer();
  const result: NodeLinkLoadResult = {
    loadType: 'search',
    data: [
      {
        encoded: 'encoded-channel',
        info: {
          identifier: 'channel',
          title: 'Berq',
          author: 'Berq',
          length: 0,
          isSeekable: false,
          isStream: false,
          uri: 'https://www.youtube.com/channel/UCDJBL7EZlt9C6Cy1fg2BTmA',
          sourceName: 'youtube',
        },
      },
      nodeLinkTrack('Playable Video', 'encoded-watch', 'youtube'),
    ],
  };
  (result.data as Array<Record<string, unknown>>)[1]!.info = {
    ...((result.data as Array<Record<string, unknown>>)[1]!.info as Record<string, unknown>),
    uri: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
  };

  const tracks = player._nodeLinkLoadResultToTracks(result, 'user-1', 5);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Playable Video');
  assert.equal(tracks[0]!.url, 'https://www.youtube.com/watch?v=1NiSbpN-LaI');
});

test('NodeLink hard-cutover resolves text search through loadtracks', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({
      url,
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
    });
    return new Response(JSON.stringify({
      loadType: 'search',
      data: [nodeLinkTrack('Search Hit', 'encoded-search', 'youtube')],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const player = createPlayer({ nodeLinkDefaultSearch: 'ytsearch' });
    const tracks = await player.previewTracks('personality crisis', {
      requestedBy: 'user-1',
      limit: 1,
    });

    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.title, 'Search Hit');
    assert.equal(tracks[0]!.source, 'youtube');
    assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-search');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/v4\/loadtracks\?/);
    assert.equal(new URL(calls[0]!.url).searchParams.get('identifier'), 'ytsearch:personality crisis');
    assert.equal(calls[0]!.authorization, 'secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NodeLink does not hard-cutover generic radio urls', async () => {
  const player = createPlayer();
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async () => {
      nodeLinkCalled = true;
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Unexpected', 'encoded-unexpected', 'http')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player.sources.resolver.normalizeInputUrl = async (url: unknown) => String(url ?? '');
  player.sources.resolver.resolveSingleUrlTrack = async (url: string, requestedBy: string | null) => [
    player.createTrackFromData({
      title: 'BBC Radio 1Xtra',
      url,
      duration: 'Live',
      source: 'radio-stream',
      isLive: true,
      requestedBy,
    }, requestedBy),
  ];

  const tracks = await player.previewTracks(
    'https://stream.live.vinto.test/bbc1xtra.m3u8',
    { requestedBy: 'user-1', limit: 1 },
  );

  assert.equal(nodeLinkCalled, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'radio-stream');
});

test('NodeLink still resolves direct youtube urls through loadtracks', async () => {
  const player = createPlayer();
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async (query: string) => {
      nodeLinkCalled = true;
      assert.equal(query, 'https://www.youtube.com/watch?v=1NiSbpN-LaI');
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Rote Flaggen', 'encoded-youtube', 'youtube')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];

  const tracks = await player.previewTracks(
    'https://www.youtube.com/watch?v=1NiSbpN-LaI',
    { requestedBy: 'user-1', limit: 1 },
  );

  assert.equal(nodeLinkCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-youtube');
});

test('NodeLink all routing mode bypasses NodeLink for generic radio playlist urls', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async (query: string) => {
      nodeLinkCalled = true;
      assert.equal(query, 'https://stream.live.vinto.test/bbc1xtra.m3u8');
      return {
        loadType: 'search',
        data: [nodeLinkTrack('NodeLink HTTP', 'encoded-http', 'http')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player.sources.resolver.normalizeInputUrl = async (url: unknown) => String(url ?? '');
  player.sources.resolver.resolveSingleUrlTrack = async (url: string, requestedBy: string | null) => [
    player.createTrackFromData({
      title: 'BBC Radio 1Xtra',
      url,
      duration: 'Live',
      source: 'radio-stream',
      isLive: true,
      requestedBy,
    }, requestedBy),
  ];

  const tracks = await player.previewTracks(
    'https://stream.live.vinto.test/bbc1xtra.m3u8',
    { requestedBy: 'user-1', limit: 1 },
  );

  assert.equal(nodeLinkCalled, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'radio-stream');
});

test('NodeLink all routing mode bypasses NodeLink for direct audio file urls', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async () => {
      nodeLinkCalled = true;
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Unexpected', 'encoded-unexpected', 'http')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player.sources.resolver.normalizeInputUrl = async (url: unknown) => String(url ?? '');
  player.sources.resolver.resolveSingleUrlTrack = async (url: string, requestedBy: string | null) => [
    player.createTrackFromData({
      title: 'Direct File',
      url,
      duration: '3:00',
      source: 'http-audio',
      isLive: false,
      requestedBy,
    }, requestedBy),
  ];

  const tracks = await player.previewTracks(
    'https://cdn.vinto.test/audio/demo.mp3',
    { requestedBy: 'user-1', limit: 1 },
  );

  assert.equal(nodeLinkCalled, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'http-audio');
});

test('NodeLink youtube-only routing mode bypasses NodeLink for text search', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'youtube-only' });
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async () => {
      nodeLinkCalled = true;
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Unexpected', 'encoded-unexpected', 'youtube')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player._searchYouTubeTracks = async (query: string, limit: number, requestedBy: string | null) => [
    player.createTrackFromData({
      title: `Local ${query}`,
      url: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
      duration: '3:00',
      source: 'youtube-search',
      requestedBy,
    }, requestedBy),
  ].slice(0, limit);

  const tracks = await player.previewTracks('personality crisis', {
    requestedBy: 'user-1',
    limit: 1,
  });

  assert.equal(nodeLinkCalled, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'youtube-search');
});

test('cross-source mirror search uses NodeLink before local yt-dlp when enabled', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  const mirroredQueries: string[] = [];

  player._resolveNodeLinkTracks = async (query: string, requestedBy: string | null) => {
    mirroredQueries.push(query);
    return [
      player.createTrackFromData({
        title: 'NodeLink Mirror Hit',
        url: 'https://www.youtube.com/watch?v=QZpMj2epGNQ',
        duration: '3:41',
        source: 'youtube',
        requestedBy,
      }, requestedBy),
    ];
  };
  player._searchYouTubeTracks = async () => {
    throw new Error('local yt-dlp path should not run');
  };

  const tracks = await player._resolveCrossSourceToYouTube([{
    title: 'Personality Crisis',
    artist: 'New York Dolls',
    isrc: 'GBXPL8230103',
    durationInSec: 221,
  }], 'user-1', 'applemusic');

  assert.deepEqual(mirroredQueries, ['"GBXPL8230103"']);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'NodeLink Mirror Hit');
  assert.equal(tracks[0]!.source, 'applemusic');
});

test('cross-source mirror search in all mode does not fallback to local yt-dlp when NodeLink has no results', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });

  player._resolveNodeLinkTracks = async () => [];
  player._searchYouTubeTracks = async () => {
    throw new Error('local yt-dlp path should not run');
  };

  await assert.rejects(
    player._resolveCrossSourceToYouTube([{
      title: 'Personality Crisis',
      artist: 'New York Dolls',
      isrc: 'GBXPL8230103',
      durationInSec: 221,
    }], 'user-1', 'applemusic'),
    /No playable YouTube matches found for applemusic source/,
  );
});

test('NodeLink all routing mode disables local youtube url fallback when NodeLink fails', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  let localResolverCalled = false;

  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async () => {
      throw new Error('nodelink unavailable');
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player._resolveSingleYouTubeTrack = async () => {
    localResolverCalled = true;
    return [
      player.createTrackFromData({
        title: 'Local Fallback',
        url: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
        duration: '3:00',
        source: 'youtube',
      }),
    ];
  };

  await assert.rejects(
    player.previewTracks('https://www.youtube.com/watch?v=1NiSbpN-LaI', { requestedBy: 'user-1', limit: 1 }),
    /NodeLink URL resolution failed and local fallback is disabled in NODELINK_ROUTING_MODE=all/,
  );
  assert.equal(localResolverCalled, false);
});

test('NodeLink streamTrack posts to v4 loadstream endpoint', async () => {
  const calls: string[] = [];
  const requestSignals: Array<unknown> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls.push(String(input));
    requestSignals.push(init?.signal ?? null);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 0, 0, 0]));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'audio/l16' },
    });
  }) as typeof fetch;

  try {
    const player = createPlayer();
    const track = player.createTrackFromData({
      title: 'NodeLink Track',
      url: 'https://example.com/track',
      duration: '3:00',
      source: 'soundcloud',
      nodelinkEncodedTrack: 'encoded-playback',
    });

    const stream = await player.nodeLinkClient!.streamTrack(track);
    stream.destroy();

    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]!).pathname, '/v4/loadstream');
    assert.equal(requestSignals[0], null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NodeLink playback starts loadStream without ffmpeg', async () => {
  const player = createPlayer();
  const streamCalls: Array<{ title: string | undefined; positionMs: number | undefined }> = [];
  player.nodeLinkClient = {
    enabled: true,
    streamTrack: async (track: Track, options: { positionMs?: number }) => {
      streamCalls.push({ title: track.title, positionMs: options.positionMs });
      return Readable.from([Buffer.alloc(3840)]);
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player._awaitInitialPlaybackChunk = async () => {};

  const track = player.createTrackFromData({
    title: 'NodeLink Track',
    url: 'https://example.com/track',
    duration: '3:00',
    source: 'soundcloud',
    nodelinkEncodedTrack: 'encoded-playback',
    nodelinkInfo: { isSeekable: true, sourceName: 'soundcloud' },
    seekStartSec: 12,
  });
  player.enqueueResolvedTracks([track]);

  await player.play();

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0]!.title, 'NodeLink Track');
  assert.equal(streamCalls[0]!.positionMs, 12000);
  assert.equal(player.ffmpeg, null);
  assert.equal(player.currentTrack?.nodelinkEncodedTrack, 'encoded-playback');

  player.stop();
});

test('NodeLink stream failure falls back to local YouTube pipeline', async () => {
  const player = createPlayer();
  const ffmpeg = {
    stdout: { pipe() {} },
    once() {},
    stderr: null,
  } as unknown as NonNullable<MusicPlayer['ffmpeg']>;

  let localPipelineStarted = false;
  player.nodeLinkClient = {
    enabled: true,
    streamTrack: async () => {
      throw new Error('NodeLink stream failed (500): {"message":"Deezer stream metadata is missing the song identifier."}');
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player._startYouTubePipeline = async () => {
    localPipelineStarted = true;
    player.ffmpeg = ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};

  player.enqueueResolvedTracks([player.createTrackFromData({
    title: 'Fallback Track',
    url: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
    duration: '4:35',
    source: 'youtube',
    nodelinkEncodedTrack: 'encoded-node',
    nodelinkInfo: { sourceName: 'youtube' },
  })]);

  await player.play();

  assert.equal(localPipelineStarted, true);
  assert.equal(player.playing, true);

  player.stop();
});
