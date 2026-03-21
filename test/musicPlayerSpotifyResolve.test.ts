import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type SpotifyRequestQuery = {
  market?: string | null;
};

type HeaderBag = Headers | Record<string, string> | Array<[string, string]>;

type RecordedSpotifyRequest = {
  url?: string;
  pathname?: string;
  authorization?: string | null;
  market?: string | null;
};

type MirrorInput = {
  title?: string;
  artist?: string | null;
  durationInSec?: number | null;
};

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: undefined,
    spotifyClientId: 'spotify-client',
    spotifyClientSecret: 'spotify-secret',
    spotifyRefreshToken: 'spotify-refresh',
    deezerArl: 'dummy-arl-cookie',
    ...overrides,
  });
}

function getHeaderValue(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;
  const normalizedName = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => String(key).toLowerCase() === normalizedName);
    return entry ? String(entry[1]) : null;
  }
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === normalizedName);
  return matchedKey ? String(headers[matchedKey] ?? '') : null;
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
  assert.equal(tracks[0]!.deezerTrackId, '999');
  assert.equal(tracks[0]!.spotifyTrackId, 'sp123');
  assert.match(tracks[0]!.source ?? '', /^spotify-/);
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

  player._resolveCrossSourceToYouTube = async (items: MirrorInput[], requestedBy: string, source: string) => {
    const first = items[0]!;
    assert.equal(source, 'spotify');
    assert.equal(items.length, 1);
    assert.equal(first.title, 'Midnight City');
    assert.equal(first.artist, 'M83');
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
  assert.equal(tracks[0]!.source, 'spotify-youtube-mirror');
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
  assert.equal(tracks[0]!.title, 'Strobe');
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

  player._resolveCrossSourceToYouTube = async (items: MirrorInput[], requestedBy: string, source: string) => {
    const first = items[0]!;
    assert.equal(source, 'spotify');
    assert.equal(requestedBy, 'user-1');
    assert.equal(items.length, 1);
    assert.equal(first.title, 'Both');
    assert.equal(first.artist, 'Headie One');
    assert.equal(first.durationInSec, 166);

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
  assert.equal(tracks[0]!.url, 'https://www.youtube.com/watch?v=demo1234567');
  assert.equal(tracks[0]!.source, 'spotify');
});

test('spotify api requests keep the /v1 prefix for relative paths', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;
  const requests: RecordedSpotifyRequest[] = [];

  player._getSpotifyAccessToken = async () => 'spotify-token';
  global.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      authorization: getHeaderValue(init?.headers as HeaderBag | undefined, 'authorization'),
    });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    await player._spotifyApiRequest('/albums/1oMWwWSqcGxpn2YhsYkNt6', { market: 'DE' });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://api.spotify.com/v1/albums/1oMWwWSqcGxpn2YhsYkNt6?market=DE');
  assert.equal(requests[0]!.authorization, 'Bearer spotify-token');
});

test('spotify track resolver retries without market when the configured market returns 404', async () => {
  const player = createPlayer({ deezerArl: null, spotifyMarket: 'US' });
  const requests: RecordedSpotifyRequest[] = [];

  player._spotifyApiRequest = async (pathname: string, query: SpotifyRequestQuery = {}) => {
    requests.push({
      pathname,
      market: query.market ?? null,
    });
    if (query.market === 'US') {
      const error = Object.assign(new Error('Spotify API request failed (404)'), { status: 404 });
      throw error;
    }

    return {
      id: 'sp404fallback',
      name: 'Fallback Song',
      duration_ms: 180000,
      external_urls: { spotify: 'https://open.spotify.com/track/sp404fallback' },
      album: {
        images: [{ url: 'https://i.scdn.co/image/fallback' }],
      },
      artists: [{ name: 'Fallback Artist' }],
    };
  };

  player._resolveCrossSourceToYouTube = async (items: MirrorInput[], requestedBy: string, source: string) => [
    (() => {
      const first = items[0]!;
      return player._buildTrack({
        title: first.title ?? 'Fallback Song',
        url: 'https://www.youtube.com/watch?v=fallback12345',
        duration: 180,
        requestedBy,
        source,
        artist: first.artist ?? null,
      });
    })(),
  ];

  const tracks = await player._resolveSpotifyTrack('https://open.spotify.com/track/sp404fallback', 'user-1');
  assert.equal(tracks.length, 1);
  assert.deepEqual(requests, [
    { pathname: '/tracks/sp404fallback', market: 'US' },
    { pathname: '/tracks/sp404fallback', market: null },
  ]);
});

test('spotify collection resolver retries without market when the configured market returns 404', async () => {
  const player = createPlayer({ deezerArl: null, spotifyMarket: 'US' });
  const requests: RecordedSpotifyRequest[] = [];

  player._spotifyApiRequest = async (pathname: string, query: SpotifyRequestQuery = {}) => {
    requests.push({
      pathname,
      market: query.market ?? null,
    });
    if (query.market === 'US') {
      const error = Object.assign(new Error('Spotify API request failed (404)'), { status: 404 });
      throw error;
    }

    return {
      tracks: {
        items: [{
          id: 'spalbum1',
          name: 'Album Fallback Song',
          duration_ms: 200000,
          external_urls: { spotify: 'https://open.spotify.com/track/spalbum1' },
          album: {
            images: [{ url: 'https://i.scdn.co/image/album-fallback' }],
          },
          artists: [{ name: 'Album Artist' }],
        }],
      },
    };
  };

  player._resolveCrossSourceToYouTube = async (items: MirrorInput[], requestedBy: string, source: string) => [
    (() => {
      const first = items[0]!;
      return player._buildTrack({
        title: first.title ?? 'Album Fallback Song',
        url: 'https://www.youtube.com/watch?v=albumfallback1',
        duration: 200,
        requestedBy,
        source,
        artist: first.artist ?? null,
      });
    })(),
  ];

  const tracks = await player._resolveSpotifyCollection('https://open.spotify.com/album/spalbumfallback', 'user-1');
  assert.equal(tracks.length, 1);
  assert.deepEqual(requests, [
    { pathname: '/albums/spalbumfallback', market: 'US' },
    { pathname: '/albums/spalbumfallback', market: null },
  ]);
});






