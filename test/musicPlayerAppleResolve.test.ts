import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';
import type { Track } from '../src/types/domain.ts';

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
    appleMusicAutoToken: false,
    ...overrides,
  });
}

test('apple music track resolver prefers deezer mirror before youtube fallback', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  global.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('https://itunes.apple.com/lookup')) {
      return {
        ok: true,
        json: async () => ({
          results: [{
            wrapperType: 'track',
            trackId: 1837237761,
            trackName: 'The Moon Cave',
            artistName: 'David Morales',
            trackTimeMillis: 356000,
            trackViewUrl: 'https://music.apple.com/vn/album/the-moon-cave/1837237742?i=1837237761',
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/demo/100x100bb.jpg',
          }],
        }),
      } as unknown as Response;
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  player._searchDeezerTracks = async () => [
    player._buildTrack({
      title: 'The Moon Cave',
      url: 'https://www.deezer.com/track/321',
      duration: 356,
      requestedBy: 'user-1',
      source: 'deezer-search-direct',
      artist: 'David Morales',
      deezerTrackId: '321',
    }),
  ];

  try {
    const tracks = await player._resolveAppleTrack(
      'https://music.apple.com/vn/album/the-moon-cave/1837237742?i=1837237761',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.deezerTrackId, '321');
    assert.match(tracks[0]!.source ?? '', /^applemusic-/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('apple music album urls resolve via apple collection path', async () => {
  const player = createPlayer();
  let collectionResolverCalled = false;

  player._resolveAppleCollection = async () => {
    collectionResolverCalled = true;
    return [
      player._buildTrack({
        title: 'First Light',
        url: 'https://www.youtube.com/watch?v=demo1234567',
        duration: 245,
        requestedBy: 'user-1',
        source: 'applemusic-youtube-mirror',
        artist: 'Artist Demo',
      }),
    ];
  };

  const tracks = await player.previewTracks('https://music.apple.com/us/album/example-album/1837237742', {
    requestedBy: 'user-1',
  });

  assert.equal(collectionResolverCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'First Light');
});

test('apple music album url with selected track resolves collection when playlist limit is above one', async () => {
  const player = createPlayer();
  const calls: Array<{ url: string; limit: number | null | undefined }> = [];

  player._resolveAppleTrack = async () => [
    player._buildTrack({
      title: 'Selected Song',
      url: 'https://www.youtube.com/watch?v=selected123',
      duration: 222,
      requestedBy: 'user-1',
      source: 'applemusic-youtube',
      artist: 'Album Artist',
    }),
  ];
  player._resolveAppleCollection = async (url, _requestedBy, limit) => {
    calls.push({ url, limit });
    return [
      player._buildTrack({
        title: 'Album Song',
        url: 'https://www.youtube.com/watch?v=album123456',
        duration: 223,
        requestedBy: 'user-1',
        source: 'applemusic-youtube',
        artist: 'Album Artist',
      }),
    ];
  };

  const firstTrack = await player.previewTracks('https://music.apple.com/us/album/demo/12345?i=67890', {
    requestedBy: 'user-1',
    limit: 1,
  });
  const collectionTracks = await player.previewTracks('https://music.apple.com/us/album/demo/12345?i=67890', {
    requestedBy: 'user-1',
    limit: 25,
  });

  assert.equal(firstTrack[0]!.title, 'Selected Song');
  assert.equal(collectionTracks[0]!.title, 'Album Song');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.limit, 25);
});

test('apple music catalog track mirrors by isrc before query fallback', async () => {
  const player = createPlayer({
    appleMusicMediaApiToken: 'catalog-token',
    appleMusicMarket: 'US',
    deezerArl: null,
  });
  const originalFetch = global.fetch;
  const searchQueries: string[] = [];

  global.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.music.apple.com/v1/catalog/us/songs/1837237761')) {
      assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, 'Bearer catalog-token');
      return {
        ok: true,
        json: async () => ({
          data: [{
            id: '1837237761',
            type: 'songs',
            attributes: {
              name: 'The Moon Cave',
              artistName: 'David Morales',
              durationInMillis: 356000,
              url: 'https://music.apple.com/us/song/the-moon-cave/1837237761',
              isrc: 'USABC2400012',
              artwork: {
                url: 'https://is1-ssl.mzstatic.com/image/thumb/demo/{w}x{h}bb.jpg',
              },
            },
          }],
        }),
      } as unknown as Response;
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  player._searchYouTubeTracks = async (query: string, _limit: number, requestedBy: string | null) => {
    searchQueries.push(query);
    if (query !== '"USABC2400012"') return [];

    return [
      player._buildTrack({
        title: 'The Moon Cave',
        url: 'https://www.youtube.com/watch?v=demo1234567',
        duration: 356,
        requestedBy,
        source: 'youtube-search',
        artist: 'David Morales',
      }),
    ];
  };

  try {
    const tracks = await player._resolveAppleTrack(
      'https://music.apple.com/us/album/the-moon-cave/1837237742?i=1837237761',
      'user-1'
    );

    assert.equal(tracks.length, 1);
    assert.deepEqual(searchQueries, ['"USABC2400012"']);
    assert.equal(tracks[0]!.source, 'applemusic');
  } finally {
    global.fetch = originalFetch;
  }
});

test('apple music playlist resolves through catalog tracks', async () => {
  const player = createPlayer({
    appleMusicMediaApiToken: 'catalog-token',
    deezerArl: null,
    maxPlaylistTracks: 10,
  });
  const originalFetch = global.fetch;

  global.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.music.apple.com/v1/catalog/us/playlists/pl.u-demo')) {
      return {
        ok: true,
        json: async () => ({
          data: [{
            id: 'pl.u-demo',
            type: 'playlists',
            relationships: {
              tracks: {
                meta: { total: 2 },
                data: [
                  {
                    id: 'song-1',
                    type: 'songs',
                    attributes: {
                      name: 'Aqua One',
                      artistName: 'Catalog Artist',
                      durationInMillis: 180000,
                      url: 'https://music.apple.com/us/song/aqua-one/song-1',
                    },
                  },
                  {
                    id: 'song-2',
                    type: 'songs',
                    attributes: {
                      name: 'Aqua Two',
                      artistName: 'Catalog Artist',
                      durationInMillis: 181000,
                      url: 'https://music.apple.com/us/song/aqua-two/song-2',
                    },
                  },
                ],
              },
            },
          }],
        }),
      } as unknown as Response;
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  player._resolveAppleMirror = async (metadataTrack: Partial<Track>) => [
    player._buildTrack({
      title: String(metadataTrack.title),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(String(metadataTrack.title)).slice(0, 11).padEnd(11, 'x')}`,
      duration: metadataTrack.duration ?? 0,
      requestedBy: metadataTrack.requestedBy,
      source: 'applemusic-youtube',
      artist: metadataTrack.artist ?? null,
    }),
  ];

  try {
    const tracks = await player.previewTracks('https://music.apple.com/us/playlist/demo/pl.u-demo', {
      requestedBy: 'user-1',
      limit: 2,
    });

    assert.equal(tracks.length, 2);
    assert.equal(tracks[0]!.title, 'Aqua One');
    assert.equal(tracks[1]!.title, 'Aqua Two');
  } finally {
    global.fetch = originalFetch;
  }
});





