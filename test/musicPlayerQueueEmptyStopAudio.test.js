import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.js';

function createVoice() {
  return {
    stopCalls: 0,
    async sendAudio() {},
    stopAudio() {
      this.stopCalls += 1;
    },
  };
}

test('play() on empty queue stops voice stream before queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player.play();

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('_handleTrackClose with empty queue stops voice stream and emits queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });
  const track = player._buildTrack({
    title: 'Track',
    url: 'https://example.com/audio',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });

  player.queue.current = track;
  player.playing = true;
  player.skipRequested = false;

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player._handleTrackClose(track, 0, null);

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('play() reports a startup pipeline close as trackError instead of queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });
  const ffmpeg = new EventEmitter();
  ffmpeg.stdout = new PassThrough();
  ffmpeg.kill = () => {};

  player._startPlayDlPipeline = async () => {
    player.ffmpeg = ffmpeg;
  };

  let queueEmptyEvent = null;
  let trackError = null;
  player.on('queueEmpty', (event) => {
    queueEmptyEvent = event;
  });
  player.on('trackError', ({ error }) => {
    trackError = error;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Broken startup track',
      url: 'https://example.com/audio',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
  ]);

  const playPromise = player.play();
  setImmediate(() => {
    ffmpeg.emit('close', 1, null);
  });
  await playPromise;

  assert.equal(queueEmptyEvent?.reason, 'startup_error');
  assert.match(String(trackError?.message ?? ''), /before audio output/i);
});

test('play() increases initial playback timeout for large seek offsets', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });
  let startupTimeoutMs = null;

  player._startYouTubePipeline = async () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
    };
  };
  player._awaitInitialPlaybackChunk = async (_stream, _proc, timeoutMs) => {
    startupTimeoutMs = timeoutMs;
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Long seek track',
      url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
      duration: '2:00:00',
      source: 'youtube',
      requestedBy: 'user-1',
      seekStartSec: 5340,
    }),
  ]);

  await player.play();

  assert.equal(startupTimeoutMs, 60_000);
});

test('seekTo rejects positions at or beyond the current track length', () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });

  player.playing = true;
  player.queue.current = player._buildTrack({
    title: 'Bounded Track',
    url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
    duration: '47:00',
    source: 'youtube',
    requestedBy: 'user-1',
  });

  assert.throws(() => {
    player.seekTo(47 * 60);
  }, /exceeds track length/i);
});
