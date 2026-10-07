import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudPlaylist, SoundCloudTrack } from 'play-dl';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

const RAW_SOUNDCLOUD_TRACK = {
  kind: 'track',
  id: 123456789,
  title: 'Real Title',
  duration: 3 * 3600 * 1000,
  uri: 'https://api.soundcloud.com/tracks/123456789',
  permalink_url: 'https://soundcloud.com/artist-name/real-title',
  artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
  user: { id: 1, username: 'Artist Name', permalink_url: 'https://soundcloud.com/artist-name' },
  publisher_metadata: { id: 9, artist: 'Publisher Artist' },
  media: { transcodings: [] },
};

function createPlayDlPlaylist() {
  return new SoundCloudPlaylist({
    kind: 'playlist',
    id: 1,
    title: 'Set',
    uri: 'https://api.soundcloud.com/playlists/1',
    duration: RAW_SOUNDCLOUD_TRACK.duration,
    user: RAW_SOUNDCLOUD_TRACK.user,
    track_count: 2,
    tracks: [RAW_SOUNDCLOUD_TRACK, { id: 987, kind: 'track' }],
  }, 'client-id');
}

function createPlayer() {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    soundcloudAutoClientId: false,
  });
}

test('soundcloud resolver prefers direct track resolver', async () => {
  const player = createPlayer();
  player._resolveSoundCloudTrackDirect = async () => [
    player._buildTrack({
      title: 'Direct SC',
      url: 'https://soundcloud.com/artist/direct-sc',
      duration: 120,
      source: 'soundcloud-direct',
      requestedBy: 'user-1',
    }),
  ];

  const tracks = await player._resolveSoundCloudTrack('https://soundcloud.com/artist/direct-sc', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'soundcloud-direct');
});

test('soundcloud playlist direct resolver rejects truncated set payloads', async () => {
  const player = createPlayer();
  player.maxPlaylistTracks = 100;
  player._soundCloudResolve = async () => ({
    kind: 'playlist',
    track_count: 100,
    tracks: Array.from({ length: 5 }, (_, index) => ({
      id: `sc-${index}`,
      title: `Track ${index}`,
      permalink_url: `https://soundcloud.com/artist/track-${index}`,
      duration: 120_000,
    })),
  });

  await assert.rejects(
    () => player._resolveSoundCloudPlaylistDirect('https://soundcloud.com/artist/sets/demo', 'user-1', 100),
    /truncated \(5\/100\)/
  );
});

test('soundcloud playlist direct resolver accepts a preview-sized truncated set payload', async () => {
  const player = createPlayer();
  player.maxPlaylistTracks = 100;
  player._soundCloudResolve = async () => ({
    kind: 'playlist',
    track_count: 100,
    tracks: Array.from({ length: 5 }, (_, index) => ({
      id: `sc-${index}`,
      title: `Track ${index}`,
      permalink_url: `https://soundcloud.com/artist/track-${index}`,
      duration: 120_000,
    })),
  });

  const tracks = await player._resolveSoundCloudPlaylistDirect('https://soundcloud.com/artist/sets/demo', 'user-1', 1);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.title, 'Track 0');
});

test('soundcloud playlist direct resolver rehydrates partial track stubs by id', async () => {
  const player = createPlayer();
  player.maxPlaylistTracks = 10;
  const fetchedIds: string[] = [];

  player._soundCloudResolve = async () => ({
    kind: 'playlist',
    track_count: 2,
    tracks: [
      {
        id: 'sc-full',
        title: 'Track 0',
        permalink_url: 'https://soundcloud.com/artist/track-0',
        duration: 120_000,
      },
      {
        id: 'sc-stub',
        // no title/permalink in this entry, common with partial SoundCloud set payloads
      },
    ],
  });
  player._fetchSoundCloudTrackById = async (trackId: unknown) => {
    fetchedIds.push(String(trackId));
    return {
      id: 'sc-stub',
      title: 'Recovered Track 1',
      permalink_url: 'https://soundcloud.com/artist/recovered-track-1',
      duration: 121_000,
    };
  };

  const tracks = await player._resolveSoundCloudPlaylistDirect('https://soundcloud.com/artist/sets/demo', 'user-1', 10);

  assert.equal(tracks.length, 2);
  assert.equal(tracks[0]?.title, 'Track 0');
  assert.equal(tracks[1]?.title, 'Recovered Track 1');
  assert.deepEqual(fetchedIds, ['sc-stub']);
});

test('soundcloud guess resolver forwards playlist limits', async () => {
  const player = createPlayer();
  let seenLimit: number | null | undefined = null;
  player._resolveSoundCloudPlaylist = async (
    _url: string,
    _requestedBy: string | null | undefined,
    limit: number | null | undefined
  ) => {
    seenLimit = limit;
    return [
      player._buildTrack({
        title: 'Limited Track',
        url: 'https://soundcloud.com/artist/limited-track',
        duration: 120,
        source: 'soundcloud-playlist-direct',
        requestedBy: 'user-1',
      }),
    ];
  };

  await player._resolveSoundCloudByGuess('https://soundcloud.com/artist/sets/demo', 'user-1', 100);

  assert.equal(seenLimit, 100);
});

test('play() uses SoundCloud pipeline for soundcloud source tracks', async () => {
  const player = createPlayer();
  let soundCloudPipelineCalled = false;

  player._startSoundCloudPipeline = async () => {
    soundCloudPipelineCalled = true;
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
      title: 'SC',
      url: 'https://soundcloud.com/artist/sc-track',
      duration: 180,
      source: 'soundcloud-direct',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();
  assert.equal(soundCloudPipelineCalled, true);
});

test('play-dl track fallback keeps title, artist, permalink and long durations', async () => {
  const player = createPlayer();
  player._resolveSoundCloudTrackDirect = async () => {
    throw new Error('resolve failed (429)');
  };
  player._loadPlayDlSoundCloud = async () => new SoundCloudTrack(RAW_SOUNDCLOUD_TRACK);

  const tracks = await player._resolveSoundCloudTrack(RAW_SOUNDCLOUD_TRACK.permalink_url, 'user-1');

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Real Title');
  assert.equal(tracks[0]!.artist, 'Artist Name');
  assert.equal(tracks[0]!.url, RAW_SOUNDCLOUD_TRACK.permalink_url);
  assert.equal(tracks[0]!.duration, '3:00:00');
  assert.equal(tracks[0]!.soundcloudTrackId, '123456789');
});

test('play-dl track fallback returns no tracks instead of null when the permalink is missing', async () => {
  const player = createPlayer();
  player._resolveSoundCloudTrackDirect = async () => {
    throw new Error('resolve failed (network)');
  };
  player._loadPlayDlSoundCloud = async () => new SoundCloudTrack({ ...RAW_SOUNDCLOUD_TRACK, permalink_url: undefined });

  const tracks = await player._resolveSoundCloudTrack('https://soundcloud.com/artist-name/real-title', 'user-1');

  assert.deepEqual(tracks, []);
});

test('play-dl playlist fallback maps fetched tracks to api metadata', async () => {
  const player = createPlayer();
  player.maxPlaylistTracks = 10;
  player._resolveSoundCloudPlaylistDirect = async () => {
    throw new Error('direct playlist payload was truncated (1/2)');
  };
  const playlist = createPlayDlPlaylist();
  playlist.all_tracks = async () => [new SoundCloudTrack(RAW_SOUNDCLOUD_TRACK)];
  player._loadPlayDlSoundCloud = async () => playlist;

  const tracks = await player._resolveSoundCloudPlaylist('https://soundcloud.com/artist-name/sets/set', 'user-1');

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Real Title');
  assert.equal(tracks[0]!.artist, 'Artist Name');
  assert.equal(tracks[0]!.url, RAW_SOUNDCLOUD_TRACK.permalink_url);
  assert.equal(tracks[0]!.source, 'soundcloud-playlist-direct');
});

test('play-dl playlist fallback uses the fetched tracks when all_tracks never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = createPlayer();
  player.maxPlaylistTracks = 10;
  player._resolveSoundCloudPlaylistDirect = async () => {
    throw new Error('direct playlist payload was truncated (1/2)');
  };
  const playlist = createPlayDlPlaylist();
  playlist.all_tracks = () => new Promise<never>(() => {});
  player._loadPlayDlSoundCloud = async () => playlist;

  const pending = player._resolveSoundCloudPlaylist('https://soundcloud.com/artist-name/sets/set', 'user-1');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  t.mock.timers.tick(20_000);
  const tracks = await pending;

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Real Title');
});

test('transcoding lookup skips an entry with an invalid url and tries the next one', async (t) => {
  const player = createPlayer();
  player._ensureSoundCloudClientId = async () => 'client-id';
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8' }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const streamUrl = await player._resolveSoundCloudTranscodingUrl({
    media: {
      transcodings: [
        { url: 'not a url', format: { protocol: 'progressive' } },
        { url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/hls', format: { protocol: 'hls' } },
      ],
    },
  });

  assert.equal(streamUrl, 'https://cf-hls-media.sndcdn.com/playlist.m3u8');
  assert.equal(requested.length, 1);
  assert.ok(requested[0]!.startsWith('https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/hls'));
});





