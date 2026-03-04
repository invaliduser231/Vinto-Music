import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.js';

function createPlayer() {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
  });
}

test('deezer resolver prefers direct ARL track resolver when configured', async () => {
  const player = createPlayer();
  let directCalled = false;

  player._resolveDeezerTrackDirect = async () => {
    directCalled = true;
    return [
      player._buildTrack({
        title: 'Deezer Direct',
        url: 'https://www.deezer.com/track/3135556',
        duration: 120,
        source: 'deezer-direct',
        requestedBy: 'user-1',
        deezerTrackId: '3135556',
      }),
    ];
  };

  const tracks = await player._resolveDeezerTrack('https://www.deezer.com/track/3135556', 'user-1');
  assert.equal(directCalled, true);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].source, 'deezer-direct');
});

test('play() uses deezer pipeline for deezer-direct source tracks', async () => {
  const player = createPlayer();
  let deezerPipelineCalled = false;

  player._startDeezerPipeline = async () => {
    deezerPipelineCalled = true;
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
      title: 'Deezer Direct',
      url: 'https://www.deezer.com/track/3135556',
      duration: 180,
      source: 'deezer-direct',
      requestedBy: 'user-1',
      deezerTrackId: '3135556',
    }),
  ]);

  await player.play();
  assert.equal(deezerPipelineCalled, true);
});

test('play() uses deezer pipeline when deezerTrackId exists even if source is not deezer-direct', async () => {
  const player = createPlayer();
  let deezerPipelineCalled = false;

  player._startDeezerPipeline = async () => {
    deezerPipelineCalled = true;
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
      title: 'Berlin',
      url: 'https://www.deezer.com/track/3135556',
      duration: 180,
      source: 'spotify-oembed-deezer-search',
      requestedBy: 'user-1',
      deezerTrackId: '3135556',
    }),
  ]);

  await player.play();
  assert.equal(deezerPipelineCalled, true);
});
