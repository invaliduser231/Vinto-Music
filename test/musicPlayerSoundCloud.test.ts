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





