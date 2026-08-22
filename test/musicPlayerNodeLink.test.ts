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

test('NodeLink load result mapping does not treat spoofed youtube hostnames as youtube URLs', () => {
  const player = createPlayer();
  const result: NodeLinkLoadResult = {
    loadType: 'search',
    data: [
      {
        encoded: 'encoded-spoofed-host',
        info: {
          identifier: 'spoofed-channel',
          title: 'Spoofed Host Result',
          author: 'Attacker',
          length: 0,
          isSeekable: false,
          isStream: false,
          uri: 'https://youtube.com.evil.test/channel/not-real',
          sourceName: 'youtube',
        },
      },
    ],
  };

  const tracks = player._nodeLinkLoadResultToTracks(result, 'user-1', 5);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Spoofed Host Result');
  assert.equal(tracks[0]!.url, 'https://youtube.com.evil.test/channel/not-real');
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

test('NodeLink previewTracks reduces text play queries to the top result even when NodeLink returns a playlist', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      loadType: 'playlist',
      data: {
        tracks: [
          nodeLinkTrack('Rote Flaggen', 'encoded-1', 'deezer'),
          nodeLinkTrack('Heimweg', 'encoded-2', 'deezer'),
          nodeLinkTrack('Schwarz', 'encoded-3', 'deezer'),
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const player = createPlayer({ nodeLinkDefaultSearch: 'deezer' });
    const tracks = await player.previewTracks('berq', {
      requestedBy: 'user-1',
      limit: 25,
    });

    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.title, 'Rote Flaggen');
    assert.equal(new URL(calls[0]!).searchParams.get('identifier'), 'deezer:berq');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a track link never expands into a queue full of search hits', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    loadType: 'search',
    data: [
      nodeLinkTrack('Mangos mit Chili', 'encoded-1', 'youtube'),
      nodeLinkTrack('Mangos mit Chili (Hardstyle Remix)', 'encoded-2', 'youtube'),
      nodeLinkTrack('Some unrelated song', 'encoded-3', 'youtube'),
      nodeLinkTrack('Another unrelated song', 'encoded-4', 'youtube'),
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    const player = createPlayer({ nodeLinkRoutingMode: 'all' });
    const tracks = await player.previewTracks(
      'https://www.deezer.com/track/3380594201',
      { requestedBy: 'user-1', limit: 100 }
    );

    assert.equal(tracks.length, 1, 'only the best match may be queued');
    assert.equal(tracks[0]!.title, 'Mangos mit Chili');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a playlist link may still expand into many tracks', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    loadType: 'playlist',
    data: {
      tracks: [
        nodeLinkTrack('One', 'encoded-1', 'deezer'),
        nodeLinkTrack('Two', 'encoded-2', 'deezer'),
        nodeLinkTrack('Three', 'encoded-3', 'deezer'),
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    const player = createPlayer({ nodeLinkRoutingMode: 'all' });
    const tracks = await player.previewTracks(
      'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      { requestedBy: 'user-1', limit: 100 }
    );

    assert.equal(tracks.length, 3, 'a real playlist must not be truncated to one');
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

test('NodeLink caches loadtracks results to avoid re-resolving the same url', async () => {
  const player = createPlayer();
  let loadTracksCalls = 0;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async (query: string) => {
      loadTracksCalls += 1;
      assert.equal(query, 'https://www.youtube.com/watch?v=1NiSbpN-LaI');
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Cached Song', 'encoded-cached', 'youtube')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];

  const first = await player.previewTracks(
    'https://www.youtube.com/watch?v=1NiSbpN-LaI',
    { requestedBy: 'user-1', limit: 1 },
  );
  const second = await player.previewTracks(
    'https://www.youtube.com/watch?v=1NiSbpN-LaI',
    { requestedBy: 'user-2', limit: 1 },
  );

  assert.equal(loadTracksCalls, 1);
  assert.equal(first[0]!.nodelinkEncodedTrack, 'encoded-cached');
  assert.equal(second[0]!.nodelinkEncodedTrack, 'encoded-cached');
  assert.equal(second[0]!.requestedBy, 'user-2');
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

test('NodeLink searchCandidates uses unified search identifier for multi-result search UI', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      loadType: 'search',
      data: [
        nodeLinkTrack('First Hit', 'encoded-1', 'deezer'),
        nodeLinkTrack('Second Hit', 'encoded-2', 'soundcloud'),
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const player = createPlayer({ nodeLinkDefaultSearch: 'deezer' });
    const tracks = await player.searchCandidates('alleine', 2, {
      requestedBy: 'user-1',
    });

    assert.equal(tracks.length, 2);
    assert.equal(new URL(calls[0]!).searchParams.get('identifier'), 'search:alleine');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('NodeLink all routing mode bypasses NodeLink for generic radio stream urls without file extension', async () => {
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
      title: 'Radio Los Santos',
      url,
      duration: 'Live',
      source: 'radio-stream',
      isLive: true,
      requestedBy,
    }, requestedBy),
  ];

  const tracks = await player.previewTracks(
    'https://audio.gtaradio.net/sa/radio-los-santos',
    { requestedBy: 'user-1', limit: 1 },
  );

  assert.equal(nodeLinkCalled, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'radio-stream');
  assert.equal(tracks[0]!.isLive, true);
});

test('NodeLink resolves extensionless urls when the local radio probe rejects them', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  let nodeLinkCalled = false;
  player.nodeLinkClient = {
    enabled: true,
    loadTracks: async () => {
      nodeLinkCalled = true;
      return {
        loadType: 'search',
        data: [nodeLinkTrack('Panama', 'encoded-lastfm', 'lastfm')],
      } as NodeLinkLoadResult;
    },
  } as unknown as MusicPlayer['nodeLinkClient'];

  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error('not a radio stream');
  }) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack(
      'https://www.last.fm/music/GReeen/_/Panama',
      'user-1',
    );

    assert.equal(nodeLinkCalled, true);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'lastfm');
    assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-lastfm');
  } finally {
    global.fetch = originalFetch;
  }
});

test('createTrackFromData normalizes stale youtube favorite source for live direct stream urls', () => {
  const player = createPlayer();

  const track = player.createTrackFromData({
    title: 'Favorite Stream',
    url: 'https://audio.gtaradio.net/sa/radio-los-santos',
    duration: 'Live',
    source: 'youtube',
  }, 'user-1');

  assert.equal(track.source, 'radio-stream');
  assert.equal(track.isLive, true);
});

test('createTrackFromData normalizes stale http favorite source for direct audio files', () => {
  const player = createPlayer();

  const track = player.createTrackFromData({
    title: 'Favorite File',
    url: 'https://cdn.vinto.test/audio/demo.mp3',
    duration: '3:00',
    source: 'http',
  }, 'user-1');

  assert.equal(track.source, 'http-audio');
  assert.equal(track.isLive, false);
});

test('createTrackFromData normalizes unresolved extensionless url source to live radio stream', () => {
  const player = createPlayer();

  const track = player.createTrackFromData({
    title: 'INPI Radio',
    url: 'https://radios.inpi.gob.mx:8080/xezv',
    duration: 'Unknown',
    source: 'url',
  }, 'user-1');

  assert.equal(track.source, 'radio-stream');
  assert.equal(track.isLive, true);
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
        title: 'Personality Crisis',
        artist: 'New York Dolls',
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
  assert.equal(tracks[0]!.title, 'Personality Crisis');
  assert.equal(tracks[0]!.source, 'applemusic');
});

test('cross-source mirror search rejects candidates that do not match the requested track', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  const mirroredQueries: string[] = [];

  player._resolveNodeLinkTracks = async (query: string, requestedBy: string | null) => {
    mirroredQueries.push(query);
    return [
      player.createTrackFromData({
        title: 'Aproveita Que Eu To Brigado (Ao Vivo)',
        artist: 'NATTAN',
        url: 'https://www.youtube.com/watch?v=QZpMj2epGNQ',
        duration: '2:33',
        source: 'youtube',
        requestedBy,
      }, requestedBy),
    ];
  };
  player._searchYouTubeTracks = async () => {
    throw new Error('local yt-dlp path should not run');
  };

  await assert.rejects(
    player._resolveCrossSourceToYouTube([{
      title: 'Panama',
      artist: 'GReeeN',
      isrc: 'DEZC62340830',
      durationInSec: 152,
    }], 'user-1', 'tidal'),
    /No playable YouTube matches found for tidal source/,
  );
  assert.deepEqual(mirroredQueries, ['"DEZC62340830"', 'GReeeN - Panama']);
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
    /NodeLink could not resolve/,
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

test('NodeLink diagnostics retain info probe details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(new URL(String(input)).pathname, '/v4/info');
    return new Response(JSON.stringify({
      isNodelink: true,
      version: {
        semver: '3.7.0',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const player = createPlayer();
    const info = await player.nodeLinkClient!.getInfo();

    assert.equal(info.isNodelink, true);
    assert.equal(info.version?.semver, '3.7.0');
    assert.deepEqual(player.nodeLinkClient!.getDiagnostics(), {
      enabled: true,
      baseUrl: 'http://nodelink:3000',
      defaultSearchIdentifier: 'search',
      requestTimeoutMs: 15000,
      streamStartTimeoutMs: 10000,
      lastRequestAtMs: player.nodeLinkClient!.lastRequestAtMs,
      lastRequestType: 'info',
      lastError: null,
      info: {
        isNodelink: true,
        version: '3.7.0',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NodeLink-resolved tracks skip local YouTube prefetch scheduling', () => {
  const player = createPlayer({ enableYouTubePrefetchedPlayback: true });
  let prefetchCalls = 0;
  player._prefetchYouTubeStreamUrl = async () => {
    prefetchCalls += 1;
    return {
      streamUrl: 'https://cdn.vinto.test/audio',
      proxyUrl: null,
    };
  };

  player.enqueueResolvedTracks([player.createTrackFromData({
    title: 'NodeLink YouTube',
    url: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
    duration: '4:35',
    source: 'youtube',
    nodelinkEncodedTrack: 'encoded-node',
    nodelinkInfo: { sourceName: 'youtube' },
  })]);

  assert.equal(prefetchCalls, 0);
  assert.equal(player.nextTrackPrefetchPromise, null);
  assert.equal(player.nextTrackPrefetchState, null);
});

test('_isNodeLinkOnlyModeForSourceTrack gates local playback by routing mode and source', () => {
  const allPlayer = createPlayer({ nodeLinkRoutingMode: 'all' });
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'deezer' }, 'https://www.deezer.com/track/3380594201'),
    true
  );
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'soundcloud' }, 'https://soundcloud.com/a/b'),
    true
  );
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'youtube' }, 'https://www.youtube.com/watch?v=abc'),
    false
  );
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'radio-stream' }, 'https://radio.example/stream'),
    false
  );
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'deezer', isLive: true }, 'https://www.deezer.com/track/1'),
    false
  );
  assert.equal(
    allPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'http-audio' }, 'https://cdn.example/song.mp3'),
    false
  );

  const smartPlayer = createPlayer({ nodeLinkRoutingMode: 'smart' });
  assert.equal(
    smartPlayer._isNodeLinkOnlyModeForSourceTrack({ source: 'deezer' }, 'https://www.deezer.com/track/3380594201'),
    false
  );
});

test('NodeLink-only mode (all) skips the local Deezer pipeline and mirrors to YouTube', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  const ffmpeg = {
    stdout: { pipe() {} },
    once() {},
    stderr: null,
  } as unknown as NonNullable<MusicPlayer['ffmpeg']>;

  let nodeLinkCalls = 0;
  let deezerPipelineCalls = 0;
  let youtubePipelineCalls = 0;
  let mirrorCalls = 0;

  player._startNodeLinkStream = async () => {
    nodeLinkCalls += 1;
    throw new Error('NodeLink stream failed: Playback pipeline exited before audio output (code=unknown).');
  };
  player.sources.deezer.startPipeline = async () => {
    deezerPipelineCalls += 1;
    player.ffmpeg = ffmpeg;
  };
  player._resolveStartupMirrorFallbackTrack = async () => {
    mirrorCalls += 1;
    return player.createTrackFromData({
      title: 'Are You That Somebody?',
      url: 'https://www.youtube.com/watch?v=abc123',
      duration: '3:00',
      source: 'deezer-mirror',
    });
  };
  player._startYouTubePipeline = async () => {
    youtubePipelineCalls += 1;
    player.ffmpeg = ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};

  player.enqueueResolvedTracks([player.createTrackFromData({
    title: 'Are You That Somebody?',
    url: 'https://www.deezer.com/track/3380594201',
    duration: '3:00',
    source: 'deezer',
    nodelinkEncodedTrack: 'encoded-deezer',
  })]);

  await player.play();

  assert.equal(nodeLinkCalls, 1);
  assert.equal(deezerPipelineCalls, 0);
  assert.equal(mirrorCalls, 1);
  assert.equal(youtubePipelineCalls, 1);

  player.stop();
});

test('NodeLink all routing mode hands Tidal links to NodeLink, which verifies the mirror itself', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all', enableTidalImport: true });
  const urlQueries: string[] = [];
  let guessCalls = 0;

  player._resolveNodeLinkTracks = async (
    query: string,
    requestedBy: string | null,
    _limit?: number | null,
    options?: { urlQuery?: boolean },
  ) => {
    if (options?.urlQuery) urlQueries.push(query);
    return [player.createTrackFromData({
      title: 'Panama',
      artist: 'GReeeN',
      url: 'https://www.deezer.com/track/2246259587',
      duration: '2:32',
      source: 'deezer',
      nodelinkEncodedTrack: 'encoded-mirror',
      requestedBy,
    }, requestedBy)];
  };
  player._resolveTidalByGuess = async () => {
    guessCalls += 1;
    return [];
  };

  const url = 'https://tidal.com/browse/track/290255059';
  const tracks = await player.previewTracks(url, { requestedBy: 'user-1', limit: 1 });

  assert.equal(guessCalls, 0, 'the local Tidal resolver must not run any more');
  assert.deepEqual(urlQueries, [url]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-mirror');
});

test('direct Deezer mirroring is skipped in all mode so mirrors keep a NodeLink encoded track', () => {
  const allModePlayer = createPlayer({ nodeLinkRoutingMode: 'all', deezerArl: 'arl', enableDeezerImport: true });
  const smartModePlayer = createPlayer({ nodeLinkRoutingMode: 'smart', deezerArl: 'arl', enableDeezerImport: true });

  assert.equal(allModePlayer._shouldUseDirectDeezerMirror(), false);
  assert.equal(smartModePlayer._shouldUseDirectDeezerMirror(), true);
});

test('NodeLink all routing mode hands Spotify track links to NodeLink instead of the local resolver', async () => {
  const player = createPlayer({
    nodeLinkRoutingMode: 'all',
    spotifyClientId: 'client-id',
    spotifyClientSecret: 'client-secret',
  });
  const urlQueries: string[] = [];

  player._spotifyApiRequestWithMarketFallback = async () => {
    throw new Error('the local Spotify resolver should not run any more');
  };
  player._resolveNodeLinkTracks = async (
    query: string,
    requestedBy: string | null,
    _limit?: number | null,
    options?: { urlQuery?: boolean },
  ) => {
    if (options?.urlQuery) urlQueries.push(query);
    return [player.createTrackFromData({
      title: 'Personality Crisis',
      artist: 'New York Dolls',
      url: 'https://www.deezer.com/track/12345',
      duration: '3:41',
      source: 'deezer',
      nodelinkEncodedTrack: 'encoded-mirror',
      requestedBy,
    }, requestedBy)];
  };
  player._searchYouTubeTracks = async () => {
    throw new Error('local yt-dlp path should not run');
  };

  const url = 'https://open.spotify.com/track/7AyE8MRf4dIK75mqqpks9S';
  const tracks = await player.previewTracks(url, { requestedBy: 'user-1', limit: 1 });

  assert.deepEqual(urlQueries, [url]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Personality Crisis');
  assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-mirror');
});

test('Spotify album links keep using NodeLink when the bot has no Spotify credentials', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  const urlQueries: string[] = [];

  player._resolveNodeLinkTracks = async (
    query: string,
    requestedBy: string | null,
    _limit?: number | null,
    options?: { urlQuery?: boolean },
  ) => {
    if (options?.urlQuery) urlQueries.push(query);
    return [player.createTrackFromData({
      title: 'Album Track',
      url: 'https://www.deezer.com/track/1',
      duration: '3:00',
      source: 'deezer',
      nodelinkEncodedTrack: 'encoded-album',
      requestedBy,
    }, requestedBy)];
  };

  const tracks = await player.previewTracks('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', {
    requestedBy: 'user-1',
    limit: 5,
  });

  assert.deepEqual(urlQueries, ['https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3']);
  assert.equal(tracks.length, 1);
});

test('a Spotify link that the bot cannot resolve locally falls back to NodeLink', async () => {
  const player = createPlayer({
    nodeLinkRoutingMode: 'all',
    spotifyClientId: 'client-id',
    spotifyClientSecret: 'client-secret',
  });
  const urlQueries: string[] = [];

  player._spotifyApiRequest = async () => {
    throw Object.assign(new Error('Spotify API request failed (404): /v1/playlists/37i9dQZF1E4DcffsQOUbbg'), { status: 404 });
  };
  player._resolveNodeLinkTracks = async (
    query: string,
    requestedBy: string | null,
    _limit?: number | null,
    options?: { urlQuery?: boolean },
  ) => {
    if (options?.urlQuery) urlQueries.push(query);
    return [player.createTrackFromData({
      title: 'Radio Track',
      url: 'https://www.deezer.com/track/42',
      duration: '3:00',
      source: 'deezer',
      nodelinkEncodedTrack: 'encoded-radio',
      requestedBy,
    }, requestedBy)];
  };

  const url = 'https://open.spotify.com/playlist/37i9dQZF1E4DcffsQOUbbg';
  const tracks = await player.previewTracks(url, { requestedBy: 'user-1', limit: 5 });

  assert.deepEqual(urlQueries, [url]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.nodelinkEncodedTrack, 'encoded-radio');
});

test('ISRC mirror lookups stop after the search backend keeps returning nothing', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'all' });
  const queries: string[] = [];

  player._resolveNodeLinkTracks = async (query: string, requestedBy: string | null) => {
    queries.push(query);
    if (query.startsWith('"')) return [];
    return [player.createTrackFromData({
      title: 'Panama',
      artist: 'GReeeN',
      url: 'https://www.youtube.com/watch?v=QZpMj2epGNQ',
      duration: '2:32',
      source: 'youtube',
      nodelinkEncodedTrack: 'encoded-mirror',
      requestedBy,
    }, requestedBy)];
  };

  const seeds = Array.from({ length: 7 }, (_, index) => ({
    title: 'Panama',
    artist: 'GReeeN',
    isrc: `DEZC6234083${index}`,
    durationInSec: 152,
  }));
  const tracks = await player._resolveCrossSourceToYouTube(seeds, 'user-1', 'tidal');

  assert.equal(tracks.length, 7);
  assert.equal(queries.filter((query) => query.startsWith('"')).length, 5);
});

test('provider links always go to NodeLink, even outside all routing mode', async () => {
  const player = createPlayer({ nodeLinkRoutingMode: 'smart' });
  const urlQueries: string[] = [];

  player._resolveNodeLinkTracks = async (
    query: string,
    requestedBy: string | null,
    _limit?: number | null,
    options?: { urlQuery?: boolean },
  ) => {
    if (options?.urlQuery) urlQueries.push(query);
    return [player.createTrackFromData({
      title: 'Mirrored',
      url: 'https://www.deezer.com/track/1',
      duration: '3:00',
      source: 'deezer',
      nodelinkEncodedTrack: 'encoded',
      requestedBy,
    }, requestedBy)];
  };

  const links = [
    'https://open.spotify.com/track/7AyE8MRf4dIK75mqqpks9S',
    'https://tidal.com/browse/track/290255059',
    'https://music.apple.com/us/album/x/1?i=2',
    'https://antinarcose.bandcamp.com/track/ssssssssss',
  ];
  for (const link of links) {
    await player.previewTracks(link, { requestedBy: 'user-1', limit: 1 });
  }

  assert.deepEqual(urlQueries, links);
});

test('a provider link fails with a clear message when NodeLink is unavailable', async () => {
  const player = createPlayer({ nodeLinkEnabled: false });

  await assert.rejects(
    player.previewTracks('https://open.spotify.com/track/7AyE8MRf4dIK75mqqpks9S', {
      requestedBy: 'user-1',
      limit: 1,
    }),
    /resolved by NodeLink, which is not available/,
  );
});

test('volume is handed to NodeLink instead of being applied locally', async () => {
  const player = createPlayer();
  const calls: Array<{ volume: number }> = [];

  player.nodeLinkClient = {
    enabled: true,
    streamTrack: async (_track: Track, options: { volume: number }) => {
      calls.push({ volume: options.volume });
      return Readable.from([Buffer.alloc(4)]);
    },
  } as unknown as MusicPlayer['nodeLinkClient'];
  player.voice = { ...player.voice, sendAudio: async () => {} } as MusicPlayer['voice'];
  player._awaitInitialPlaybackChunk = async () => {};

  player.setVolumePercent(25);
  await player._startNodeLinkStream(
    player.createTrackFromData({
      title: 'x',
      url: 'https://www.youtube.com/watch?v=1NiSbpN-LaI',
      duration: '3:00',
      source: 'youtube',
      nodelinkEncodedTrack: 'encoded',
    }),
    player.playbackStartupToken ?? 0,
    0,
  );

  assert.deepEqual(calls, [{ volume: 25 }]);
  assert.equal(player.streamAppliedVolumePercent, 25);
  assert.equal(player._shouldUseLiveAudioProcessor(), false, 'no local processing needed any more');

  player.stop();
});

test('a volume change during playback is applied relative to what the stream already does', () => {
  const player = createPlayer();
  player.setVolumePercent(50);
  player.streamAppliedVolumePercent = 50;

  assert.equal(player._shouldUseLiveAudioProcessor(), false);

  player.setVolumePercent(100);
  assert.equal(player._getLiveAudioProcessorState().volumePercent, 200);
  assert.equal(player._shouldUseLiveAudioProcessor(), true);
});

test('a filter preset keeps volume local so both are applied together', () => {
  const player = createPlayer();
  player.setVolumePercent(40);
  player.setFilterPreset('bassboost');

  assert.equal(player._canDelegateVolumeToStream(), false);
});
