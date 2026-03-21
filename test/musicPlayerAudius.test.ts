import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

function createPlayer() {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
  });
}

test('audius url resolver builds direct track', async () => {
  const player = createPlayer();
  player._audiusApiRequest = async () => ({
    data: {
      id: 'audius-track-1',
      kind: 'track',
      title: 'Audius Song',
      duration: 180,
      user: { handle: 'artist', name: 'Artist' },
      permalink: 'audius-song',
      artwork: { '480x480': 'https://cdn.audius.co/art.jpg' },
    },
  });

  const tracks = await player._resolveAudiusByUrl('https://audius.co/artist/audius-song', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.source, 'audius-direct');
  assert.equal(tracks[0]!.audiusTrackId, 'audius-track-1');
});

test('play() uses audius pipeline for audius source tracks', async () => {
  const player = createPlayer();
  let audiusPipelineCalled = false;

  player._startAudiusPipeline = async () => {
    audiusPipelineCalled = true;
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
      title: 'Audius Track',
      url: 'https://audius.co/artist/audius-song',
      duration: 200,
      source: 'audius-direct',
      requestedBy: 'user-1',
      audiusTrackId: 'audius-track-1',
    }),
  ]);

  await player.play();
  assert.equal(audiusPipelineCalled, true);
});





