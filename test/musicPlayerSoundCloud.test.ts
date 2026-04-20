import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

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





