import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';
import { MusicPlayer } from '../src/player/MusicPlayer.ts';

function createGateway() {
  return {
    joinVoice() {},
    leaveVoice() {},
    on() {},
    off() {},
  };
}

function createConnectedConnection() {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });
  connection.room = { isConnected: true } as never;
  return connection;
}

function tick(ms = 5) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// The pump keeps up to MAX_QUEUE_MS buffered, so the track is not audible-complete
// when the source stream ends. Draining has to wait for both stages.
test('waitForPlaybackDrain waits for the pump to finish before waiting on playout', async () => {
  const connection = createConnectedConnection();
  const order: string[] = [];

  let playoutCalls = 0;
  connection.audioSource = {
    queuedDuration: 600,
    async waitForPlayout() {
      playoutCalls += 1;
      order.push('playout');
    },
  } as never;
  connection.currentAudioStream = {} as never;

  const drained = connection.waitForPlaybackDrain(1_000);
  await tick(20);

  assert.equal(playoutCalls, 0, 'playout must not be awaited while the pump still runs');

  order.push('pump-finished');
  connection.currentAudioStream = null;
  await drained;

  assert.deepEqual(order, ['pump-finished', 'playout']);
});

test('waitForPlaybackDrain returns immediately when there is no audio source', async () => {
  const connection = createConnectedConnection();
  connection.audioSource = null;

  await connection.waitForPlaybackDrain(1_000);
});

test('waitForPlaybackDrain returns immediately when the room is disconnected', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });
  let playoutCalls = 0;
  connection.audioSource = {
    queuedDuration: 600,
    async waitForPlayout() {
      playoutCalls += 1;
    },
  } as never;

  await connection.waitForPlaybackDrain(1_000);

  assert.equal(playoutCalls, 0);
});

// A skip bumps the pump token. Draining must not hold the transition back.
test('waitForPlaybackDrain aborts when the pump token changes', async () => {
  const connection = createConnectedConnection();
  let playoutCalls = 0;
  connection.audioSource = {
    queuedDuration: 600,
    async waitForPlayout() {
      playoutCalls += 1;
    },
  } as never;
  connection.currentAudioStream = {} as never;

  const drained = connection.waitForPlaybackDrain(5_000);
  await tick(20);
  connection.audioPumpToken += 1;

  await drained;

  assert.equal(playoutCalls, 0, 'a superseded pump must not wait for playout');
});

test('waitForPlaybackDrain gives up when playout never resolves', async () => {
  const connection = createConnectedConnection();
  connection.audioSource = {
    queuedDuration: 600,
    waitForPlayout() {
      return new Promise(() => {});
    },
  } as never;
  connection.currentAudioStream = null;

  const startedAt = Date.now();
  await connection.waitForPlaybackDrain(60);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 50, `expected the timeout to be honoured, waited ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `expected the drain to give up, waited ${elapsed}ms`);
});

test('waitForPlaybackDrain stops waiting for a stuck pump once the budget is spent', async () => {
  const connection = createConnectedConnection();
  let playoutCalls = 0;
  connection.audioSource = {
    queuedDuration: 600,
    async waitForPlayout() {
      playoutCalls += 1;
    },
  } as never;
  connection.currentAudioStream = {} as never;

  const startedAt = Date.now();
  await connection.waitForPlaybackDrain(60);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2_000, `expected the drain to give up, waited ${elapsed}ms`);
  assert.equal(playoutCalls, 0);
});

test('a finished track drains the buffer before the close handler runs', async () => {
  const order: string[] = [];
  const voice = {
    connected: true,
    async sendAudio() {},
    stopAudio() {},
    async waitForPlaybackDrain() {
      order.push('drain');
    },
  };

  const player = new MusicPlayer(voice, {});
  player._handleTrackClose = async () => {
    order.push('close');
  };

  const ffmpeg = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void; stderr: PassThrough };
  ffmpeg.stdout = new PassThrough();
  ffmpeg.stderr = new PassThrough();
  ffmpeg.kill = () => {};
  player._startHttpUrlPipeline = async () => {
    player.ffmpeg = ffmpeg as never;
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._scheduleNextTrackPrefetch = () => {};

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Drained Track',
      url: 'https://example.com/audio',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();
  ffmpeg.emit('close', 0, null);
  await tick(20);

  assert.deepEqual(order, ['drain', 'close']);
});

// Skips and seeks want the buffer gone, not played out.
test('a skip does not drain the buffer before closing the track', async () => {
  const order: string[] = [];
  const voice = {
    connected: true,
    async sendAudio() {},
    stopAudio() {},
    async waitForPlaybackDrain() {
      order.push('drain');
    },
  };

  const player = new MusicPlayer(voice, {});
  player.skipRequested = true;

  await player._drainPlaybackBeforeClose();

  assert.deepEqual(order, []);
});

test('a pending seek does not drain the buffer before closing the track', async () => {
  const order: string[] = [];
  const voice = {
    connected: true,
    async sendAudio() {},
    stopAudio() {},
    async waitForPlaybackDrain() {
      order.push('drain');
    },
  };

  const player = new MusicPlayer(voice, {});
  player.pendingSeekTrack = player._buildTrack({
    title: 'Seek Target',
    url: 'https://example.com/audio',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });

  await player._drainPlaybackBeforeClose();

  assert.deepEqual(order, []);
});

test('a voice adapter without drain support does not break track close', async () => {
  const voice = {
    connected: true,
    async sendAudio() {},
    stopAudio() {},
  };

  const player = new MusicPlayer(voice, {});

  await player._drainPlaybackBeforeClose();
});

test('a failing drain does not prevent the track from closing', async () => {
  const voice = {
    connected: true,
    async sendAudio() {},
    stopAudio() {},
    async waitForPlaybackDrain() {
      throw new Error('drain exploded');
    },
  };

  const player = new MusicPlayer(voice, { logger: null });

  await player._drainPlaybackBeforeClose();
});
