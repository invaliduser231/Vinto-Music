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





