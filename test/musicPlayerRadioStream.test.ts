import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type ResponseInitShape = {
  url: string;
  contentType?: string | null;
  ok?: boolean;
  headers?: Record<string, string>;
  bodyText?: string;
};

function createPlayer() {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
  });
}

function createResponse({
  url,
  contentType,
  ok = true,
  headers = {},
  bodyText = '',
}: ResponseInitShape): Response {
  const headerEntries: Array<[string, string]> = [
    ['content-type', contentType ?? ''],
    ...Object.entries(headers).map(
      ([key, value]) => [String(key).toLowerCase(), String(value)] as [string, string]
    ),
  ];
  const headerMap = new Map<string, string>(headerEntries);

  return {
    ok,
    url,
    headers: {
      get(name: string) {
        return headerMap.get(String(name).toLowerCase()) ?? null;
      },
    },
    body: {
      async cancel() {},
    },
    async text() {
      return bodyText;
    },
  } as unknown as Response;
}

test('generic URL resolver builds live radio track from direct audio stream response', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;
  global.fetch = (async () => createResponse({
    url: 'https://radio.example.com/live',
    contentType: 'audio/mpeg',
    headers: {
      'icy-name': 'Retro FM',
    },
  })) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack('https://radio.example.com/listen', 'user-1');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'radio-stream');
    assert.equal(tracks[0]!.title, 'Retro FM');
    assert.equal(tracks[0]!.duration, 'Live');
    assert.equal(tracks[0]!.isLive, true);
    assert.equal(tracks[0]!.url, 'https://radio.example.com/live');
  } finally {
    global.fetch = originalFetch;
  }
});

test('generic URL resolver follows pls playlists to the final radio stream', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;
  const requests: string[] = [];
  global.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://radio.example.com/tunein') {
      return createResponse({
        url,
        contentType: 'audio/x-scpls',
        bodyText: '[playlist]\nFile1=https://stream.radio.example.com/live\nTitle1=Radio Example\nLength1=-1\nNumberOfEntries=1\nVersion=2\n',
      });
    }

    return createResponse({
      url: 'https://stream.radio.example.com/live',
      contentType: 'audio/mpeg',
      headers: {
        'icy-name': 'Radio Example',
      },
    });
  }) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack('https://radio.example.com/tunein', 'user-1');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'radio-stream');
    assert.equal(tracks[0]!.title, 'Radio Example');
    assert.equal(tracks[0]!.url, 'https://stream.radio.example.com/live');
    assert.deepEqual(requests, [
      'https://radio.example.com/tunein',
      'https://radio.example.com/tunein',
      'https://stream.radio.example.com/live',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('generic URL resolver follows relative m3u8 playlist entries for live streams', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;
  const requests: string[] = [];
  global.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://radio.example.com/live/master.m3u8') {
      return createResponse({
        url,
        contentType: 'application/vnd.apple.mpegurl',
        bodyText: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=96000\nvariant/audio.m3u8\n',
      });
    }

    return createResponse({
      url: 'https://radio.example.com/live/variant/audio.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
      headers: {
        'icy-name': 'BBC 1Xtra',
      },
      bodyText: '#EXTM3U\n#EXTINF:-1,\nchunk1.aac\n',
    });
  }) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack('https://radio.example.com/live/master.m3u8', 'user-1');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'radio-stream');
    assert.equal(tracks[0]!.title, 'BBC 1Xtra');
    assert.equal(tracks[0]!.duration, 'Live');
    assert.equal(tracks[0]!.isLive, true);
    assert.equal(tracks[0]!.url, 'https://radio.example.com/live/variant/audio.m3u8');
    assert.deepEqual(requests, [
      'https://radio.example.com/live/master.m3u8',
      'https://radio.example.com/live/variant/audio.m3u8',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('generic URL resolver falls back to a live radio track for non-youtube m3u8 urls when metadata probing fails', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  global.fetch = (async () => {
    throw new Error('network blocked');
  }) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack(
      'http://as-hls-ww-live.akamaized.net/pool_92079267/live/ww/bbc_1xtra/bbc_1xtra.isml/bbc_1xtra-audio%3d96000.norewind.m3u8',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'radio-stream');
    assert.equal(tracks[0]!.duration, 'Live');
    assert.equal(tracks[0]!.isLive, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('generic URL resolver treats direct mp3 files as non-live HTTP audio tracks', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  player._probeHttpAudioTrack = async () => ({
    durationSec: 214,
    title: 'Demo MP3',
    artist: 'Example Artist',
  });
  global.fetch = (async () => createResponse({
    url: 'https://cdn.example.com/files/demo.mp3',
    contentType: 'audio/mpeg',
  })) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack('https://cdn.example.com/files/demo.mp3', 'user-1');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'http-audio');
    assert.equal(tracks[0]!.title, 'Demo MP3');
    assert.equal(tracks[0]!.artist, 'Example Artist');
    assert.equal(tracks[0]!.duration, '3:34');
    assert.equal(tracks[0]!.isLive, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('generic URL resolver does not classify attachment mp3 urls as radio streams', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  player._probeHttpAudioTrack = async () => ({
    durationSec: 3774,
    title: 'Funky 7 Inchies',
    artist: 'BASIC',
  });
  global.fetch = (async () => createResponse({
    url: 'https://fluxerusercontent.com/attachments/demo/song.mp3',
    contentType: 'audio/mpeg',
    headers: {
      'content-disposition': 'attachment; filename="song.mp3"',
    },
  })) as typeof fetch;

  try {
    const tracks = await player._resolveSingleUrlTrack('https://fluxerusercontent.com/attachments/demo/song.mp3', 'user-1');
    assert.equal(tracks[0]!.source, 'http-audio');
    assert.equal(tracks[0]!.duration, '1:02:54');
    assert.equal(tracks[0]!.isLive, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('play() uses direct HTTP pipeline for live radio tracks', async () => {
  const player = createPlayer();
  let radioPipelineCalled = false;

  player._startHttpUrlPipeline = async () => {
    radioPipelineCalled = true;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
    };
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    throw new Error('youtube pipeline should not be used');
  };
  player._startPlayDlPipeline = async () => {
    throw new Error('play-dl pipeline should not be used');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Retro FM',
      url: 'https://radio.example.com/live',
      duration: 'Live',
      source: 'radio-stream',
      requestedBy: 'user-1',
      isLive: true,
    }),
  ]);

  await player.play();
  assert.equal(radioPipelineCalled, true);
  assert.equal(player.canSeekCurrentTrack(), false);
});

test('play() uses direct HTTP pipeline for non-live http audio tracks and allows seek', async () => {
  const player = createPlayer();
  let httpPipelineCalled = false;
  let seekSec = null;

  player._startHttpUrlPipeline = async (_url: string, seek: number | undefined) => {
    httpPipelineCalled = true;
    seekSec = seek;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
    };
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    throw new Error('youtube pipeline should not be used');
  };
  player._startPlayDlPipeline = async () => {
    throw new Error('play-dl pipeline should not be used');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Local MP3',
      url: 'https://cdn.example.com/files/demo.mp3',
      duration: '03:34',
      source: 'http-audio',
      requestedBy: 'user-1',
      seekStartSec: 15,
      isLive: false,
    }),
  ]);

  await player.play();
  assert.equal(httpPipelineCalled, true);
  assert.equal(seekSec, 15);
  assert.equal(player.canSeekCurrentTrack(), true);
});

test('non-youtube m3u8 urls bypass play-dl validation and use the generic url resolver', async () => {
  const player = createPlayer();
  let resolverCalls = 0;

  player.sources.resolver.resolveSingleUrlTrack = async (url, requestedBy) => {
    resolverCalls += 1;
    return [
      player._buildTrack({
        title: 'BBC Radio One',
        url,
        duration: 'Live',
        source: 'radio-stream',
        requestedBy,
        isLive: true,
      }),
    ];
  };

  try {
    const tracks = await player._resolveTracks(
      'http://as-hls-ww-live.akamaized.net/pool_01505109/live/ww/bbc_radio_one/bbc_radio_one.isml/bbc_radio_one-audio%3d96000.norewind.m3u8',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'radio-stream');
    assert.equal(resolverCalls, 1);
  } finally {}
});






