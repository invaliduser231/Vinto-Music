import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.js';

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    spotifyClientId: 'spotify-client',
    spotifyClientSecret: 'spotify-secret',
    spotifyRefreshToken: 'spotify-refresh',
    deezerArl: 'dummy-arl-cookie',
    ...overrides,
  });
}

test('spotify track resolver prefers deezer mirror before youtube fallback', async () => {
  const player = createPlayer();

  player._spotifyApiRequest = async () => ({
    id: 'sp123',
    name: 'Teardrop',
    duration_ms: 330000,
    preview_url: 'https://p.scdn.co/mp3-preview/demo',
    external_urls: { spotify: 'https://open.spotify.com/track/sp123' },
    album: {
      images: [{ url: 'https://i.scdn.co/image/demo' }],
    },
    artists: [{ name: 'Massive Attack' }],
  });

  player._searchDeezerTracks = async () => [
    player._buildTrack({
      title: 'Teardrop',
      url: 'https://www.deezer.com/track/999',
      duration: 330,
      requestedBy: 'user-1',
      source: 'deezer-search-direct',
      artist: 'Massive Attack',
      deezerTrackId: '999',
    }),
  ];

  const tracks = await player._resolveSpotifyTrack('https://open.spotify.com/track/sp123', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].deezerTrackId, '999');
  assert.equal(tracks[0].spotifyTrackId, 'sp123');
  assert.match(tracks[0].source, /^spotify-/);
});

test('spotify track resolver falls back to youtube mirroring when direct mirror is unavailable', async () => {
  const player = createPlayer({ deezerArl: null });

  player._spotifyApiRequest = async () => ({
    id: 'sp456',
    name: 'Midnight City',
    duration_ms: 244000,
    external_urls: { spotify: 'https://open.spotify.com/track/sp456' },
    album: {
      images: [{ url: 'https://i.scdn.co/image/demo2' }],
    },
    artists: [{ name: 'M83' }],
  });

  player._resolveCrossSourceToYouTube = async (items, requestedBy, source) => {
    assert.equal(source, 'spotify');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Midnight City');
    assert.equal(items[0].artist, 'M83');
    return [
      player._buildTrack({
        title: 'Midnight City',
        url: 'https://www.youtube.com/watch?v=dX3k_QDnzHE',
        duration: 244,
        requestedBy,
        source: 'spotify-youtube-mirror',
        artist: 'M83',
      }),
    ];
  };

  const tracks = await player._resolveSpotifyTrack('https://open.spotify.com/track/sp456', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].source, 'spotify-youtube-mirror');
});

test('spotify artist URLs resolve via top tracks path', async () => {
  const player = createPlayer();
  let artistResolverCalled = false;

  player._resolveSpotifyArtist = async () => {
    artistResolverCalled = true;
    return [
      player._buildTrack({
        title: 'Strobe',
        url: 'https://www.youtube.com/watch?v=tKi9Z-f6qX4',
        duration: 640,
        requestedBy: 'user-1',
        source: 'spotify-artist',
        artist: 'deadmau5',
      }),
    ];
  };

  const tracks = await player.previewTracks('https://open.spotify.com/artist/2CIMQHirSU0MQqyYHq0eOx', {
    requestedBy: 'user-1',
  });
  assert.equal(artistResolverCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, 'Strobe');
});

test('spotify playlist youtube mirroring keeps the artist in the search query', async () => {
  const player = createPlayer({ deezerArl: null });

  player._spotifyApiRequest = async () => ({
    tracks: {
      items: [{
        track: {
          id: 'sppl123',
          name: 'Both',
          duration_ms: 166000,
          external_urls: { spotify: 'https://open.spotify.com/track/sppl123' },
          album: {
            images: [{ url: 'https://i.scdn.co/image/demo-playlist' }],
          },
          artists: [{ name: 'Headie One' }],
        },
      }],
    },
  });

  player._resolveCrossSourceToYouTube = async (items, requestedBy, source) => {
    assert.equal(source, 'spotify');
    assert.equal(requestedBy, 'user-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Both');
    assert.equal(items[0].artist, 'Headie One');
    assert.equal(items[0].durationInSec, 166);

    return [
      player._buildTrack({
        title: 'Headie One - Both',
        url: 'https://www.youtube.com/watch?v=demo1234567',
        duration: 166,
        requestedBy,
        source,
        artist: 'Headie One',
      }),
    ];
  };

  const tracks = await player._resolveSpotifyCollection('https://open.spotify.com/playlist/37i9dQZF1DX1tyCD9QhIWF', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].url, 'https://www.youtube.com/watch?v=demo1234567');
  assert.equal(tracks[0].source, 'spotify');
});

test('spotify api requests keep the /v1 prefix for relative paths', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;
  const requests = [];

  player._getSpotifyAccessToken = async () => 'spotify-token';
  global.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: init?.headers?.Authorization ?? init?.headers?.authorization ?? null,
    });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  };

  try {
    await player._spotifyApiRequest('/albums/1oMWwWSqcGxpn2YhsYkNt6', { market: 'DE' });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.spotify.com/v1/albums/1oMWwWSqcGxpn2YhsYkNt6?market=DE');
  assert.equal(requests[0].authorization, 'Bearer spotify-token');
});
