import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type FakeProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killCalls: string[];
  kill: (signal?: string | number) => void;
};

type VoiceMock = {
  stopCalls: number;
  sendAudio: () => Promise<void>;
  stopAudio: () => void;
};

function createVoice() {
  return {
    stopCalls: 0,
    async sendAudio() {},
    stopAudio() {
      this.stopCalls += 1;
    },
  } as VoiceMock;
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killCalls = [];
  proc.kill = (signal) => {
    proc.killCalls.push(String(signal ?? 'SIGTERM'));
  };
  return proc;
}

test('stop() aborts startup without emitting startup errors or trackStart', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });
  const sourceProc = createFakeProcess();
  const ffmpeg = createFakeProcess();
  let releaseStartupChunk: (() => void) | null = null;

  player._startYouTubePipeline = async () => {
    player.sourceProc = sourceProc;
    player.ffmpeg = ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => new Promise<void>((resolve) => {
    releaseStartupChunk = () => resolve();
  });

  let trackStartCount = 0;
  let trackErrorCount = 0;
  player.on('trackStart', () => {
    trackStartCount += 1;
  });
  player.on('trackError', () => {
    trackErrorCount += 1;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Startup Track',
      url: 'https://www.youtube.com/watch?v=demo1234567',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  const playPromise = player.play();
  await new Promise((resolve) => setImmediate(resolve));
  player.stop();
  const finishStartup = releaseStartupChunk;
  assert.equal(typeof finishStartup, 'function');
  if (finishStartup) {
    (finishStartup as () => void)();
  }
  await playPromise;

  assert.equal(trackStartCount, 0);
  assert.equal(trackErrorCount, 0);
  assert.equal(player.playing, false);
  assert.equal(player.currentTrack, null);
  assert.deepEqual(sourceProc.killCalls, ['SIGKILL']);
  assert.deepEqual(ffmpeg.killCalls, ['SIGKILL']);
});

test('play() cleans up lingering processes before starting a new track', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { logger: null });
  const staleSourceProc = createFakeProcess();
  const staleFfmpeg = createFakeProcess();
  const nextFfmpeg = createFakeProcess();

  player.sourceProc = staleSourceProc;
  player.ffmpeg = staleFfmpeg;
  player._startYouTubePipeline = async () => {
    player.ffmpeg = nextFfmpeg;
    player.sourceProc = null;
  };
  player._awaitInitialPlaybackChunk = async () => {};

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Fresh Track',
      url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.deepEqual(staleSourceProc.killCalls, ['SIGKILL']);
  assert.deepEqual(staleFfmpeg.killCalls, ['SIGKILL']);
  assert.equal(player.ffmpeg, nextFfmpeg);
  assert.equal(player.playing, true);
});





