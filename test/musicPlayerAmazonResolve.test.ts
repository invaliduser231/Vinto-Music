import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type AmazonLookupOverrides = {
  albumList?: unknown[];
  trackList?: unknown[];
  fallback?: ((input: string | URL | Request) => Promise<Response>) | null;
};

type MirrorInput = {
  title?: string;
  artist?: string | null;
};

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
    ...overrides,
  });
}

function createAmazonLookupFetchHandler(overrides: AmazonLookupOverrides = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/config.json')) {
      return {
        ok: true,
        json: async () => ({
          siteRegion: 'EU',
          marketplaceId: 'A1PA6795UKMFR9',
          musicTerritory: 'DE',
          deviceType: 'A16ZV8BU3SN1N3',
          deviceId: 'test-device-id',
          customerId: '',
          csrf: {
            token: 'csrf-token',
            rnd: '123',
            ts: '456',
          },
        }),
      } as unknown as Response;
    }

    if (url.includes('/EU/api/muse/legacy/lookup')) {
      return {
        ok: true,
        json: async () => ({
          albumList: overrides.albumList ?? [],
          trackList: overrides.trackList ?? [],
          artistList: [],
          playlistList: [],
          metadata: null,
        }),
      } as unknown as Response;
    }

    if (typeof overrides.fallback === 'function') {
      return overrides.fallback(input);
    }

    return {
      ok: true,
      text: async () => '<html></html>',
    } as unknown as Response;
  };
}

test('amazon music track resolver prefers deezer mirror before youtube fallback', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  global.fetch = (async () => ({
    ok: true,
    text: async () => `<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="Teardrop by Massive Attack on Amazon Music" />
          <meta property="og:description" content="Listen to Teardrop by Massive Attack on Amazon Music." />
          <meta property="og:image" content="https://m.media-amazon.com/images/demo.jpg" />
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"MusicRecording","name":"Teardrop","byArtist":{"@type":"MusicGroup","name":"Massive Attack"},"duration":"PT5M30S","url":"https://music.amazon.com/tracks/B000TEST"}
          </script>
        </head>
      </html>`,
  })) as unknown as typeof fetch;

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

  try {
    const tracks = await player._resolveAmazonTrack(
      'https://music.amazon.com/tracks/B000TEST',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.deezerTrackId, '999');
    assert.match(tracks[0]!.source ?? '', /^amazonmusic-/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('amazon music track resolver falls back to youtube mirroring when deezer mirror is unavailable', async () => {
  const player = createPlayer({ deezerArl: null });
  const originalFetch = global.fetch;

  global.fetch = (async () => ({
    ok: true,
    text: async () => `<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="Midnight City by M83 on Amazon Music" />
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"MusicRecording","name":"Midnight City","byArtist":{"@type":"MusicGroup","name":"M83"},"duration":"PT4M4S","url":"https://music.amazon.com/tracks/B000CITY"}
          </script>
        </head>
      </html>`,
  })) as unknown as typeof fetch;

  player._resolveCrossSourceToYouTube = async (items: MirrorInput[], requestedBy: string, source: string) => {
    const first = items[0]!;
    assert.equal(source, 'amazonmusic');
    assert.equal(items.length, 1);
    assert.equal(first.title, 'Midnight City');
    assert.equal(first.artist, 'M83');
    return [
      player._buildTrack({
        title: 'Midnight City',
        url: 'https://www.youtube.com/watch?v=dX3k_QDnzHE',
        duration: 244,
        requestedBy,
        source: 'amazonmusic-youtube-mirror',
        artist: 'M83',
      }),
    ];
  };

  try {
    const tracks = await player._resolveAmazonTrack(
      'https://music.amazon.com/tracks/B000CITY',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.source, 'amazonmusic-youtube-mirror');
  } finally {
    global.fetch = originalFetch;
  }
});

test('amazon music album urls resolve via amazon collection path', async () => {
  const player = createPlayer();
  let collectionResolverCalled = false;

  player._resolveAmazonCollection = async () => {
    collectionResolverCalled = true;
    return [
      player._buildTrack({
        title: 'First Light',
        url: 'https://www.youtube.com/watch?v=demo1234567',
        duration: 245,
        requestedBy: 'user-1',
        source: 'amazonmusic-youtube-mirror',
        artist: 'Artist Demo',
      }),
    ];
  };

  const tracks = await player.previewTracks('https://music.amazon.com/albums/B08N5KWB9H', {
    requestedBy: 'user-1',
  });

  assert.equal(collectionResolverCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'First Light');
});

test('amazon music track resolver uses amazon legacy lookup before HTML fallback', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  global.fetch = createAmazonLookupFetchHandler({
    trackList: [{
      asin: 'B01EP9C1HG',
      title: 'Drüben bei Penny',
      duration: 274,
      primaryArtistName: 'Von Wegen Lisbeth',
      album: {
        asin: 'B01EP9BXIO',
        title: 'Grande',
        image: 'https://m.media-amazon.com/images/demo.jpg',
      },
    }],
  });

  player._searchDeezerTracks = async () => [
    player._buildTrack({
      title: 'Drüben bei Penny',
      url: 'https://www.deezer.com/track/128548153',
      duration: 274,
      requestedBy: 'user-1',
      source: 'deezer-search-direct',
      artist: 'Von Wegen Lisbeth',
      deezerTrackId: '128548153',
    }),
  ];

  try {
    const tracks = await player._resolveAmazonTrack(
      'https://music.amazon.de/albums/B01EP9BXIO?trackAsin=B01EP9C1HG',
      'user-1'
    );
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.deezerTrackId, '128548153');
    assert.match(tracks[0]!.source ?? '', /^amazonmusic-/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('amazon music album resolver falls back to deezer album-track search instead of collapsing to one track', async () => {
  const player = createPlayer();
  const originalFetch = global.fetch;

  global.fetch = createAmazonLookupFetchHandler({
    albumList: [{
      asin: 'B01EP9BXIO',
      title: 'Grande',
      primaryArtistName: 'Von Wegen Lisbeth',
      image: 'https://m.media-amazon.com/images/demo.jpg',
    }],
  });

  player._deezerApiRequest = async () => ({
    data: [
      {
        id: 128548139,
        title: 'Meine Kneipe',
        duration: 199,
        link: 'https://www.deezer.com/track/128548139',
        album: { title: 'Grande' },
        artist: { name: 'Von Wegen Lisbeth' },
      },
      {
        id: 128548143,
        title: 'Cherie',
        duration: 190,
        link: 'https://www.deezer.com/track/128548143',
        album: { title: 'Grande' },
        artist: { name: 'Von Wegen Lisbeth' },
      },
      {
        id: 128548149,
        title: 'Komm mal rueber bitte',
        duration: 210,
        link: 'https://www.deezer.com/track/128548149',
        album: { title: 'Grande' },
        artist: { name: 'Von Wegen Lisbeth' },
      },
    ],
  });

  try {
    const tracks = await player._resolveAmazonCollection(
      'https://music.amazon.de/albums/B01EP9BXIO',
      'user-1'
    );
    assert.equal(tracks.length, 3);
    assert.equal(tracks[0]!.title, 'Meine Kneipe');
    assert.match(tracks[0]!.source ?? '', /^amazonmusic-/);
  } finally {
    global.fetch = originalFetch;
  }
});





