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

test('_handleTrackClose warns when yt-dlp source process ended long before expected duration', async () => {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const player = new MusicPlayer(createVoice(), {
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });

  const track = player._buildTrack({
    title: 'Long YouTube Mix',
    url: 'https://www.youtube.com/watch?v=_O52D4nb1pg',
    duration: '1:14:15',
    source: 'youtube',
    requestedBy: 'user-1',
  });

  player.queue.current = track;
  player.playing = true;
  player.trackStartedAtMs = Date.now() - (56 * 60 * 1000);
  player.currentTrackOffsetSec = 0;
  player.activeSourceProcessCloseInfo = {
    code: 0,
    signal: null,
    atMs: Date.now(),
    stderrTail: 'upstream closed',
    url: track.url ?? null,
  };

  await player._handleTrackClose(track, 0, null);

  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Source process ended before expected track duration'
    && meta?.elapsedSeconds === 56 * 60
    && meta?.expectedDurationSeconds === 4455
  )));
});

test('_handleTrackClose auto-recovers an early-ended YouTube track without source close metadata', async () => {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const player = new MusicPlayer(createVoice(), {
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });

  const track = player._buildTrack({
    title: 'Prefetched Track',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    duration: '02:56',
    source: 'youtube',
    requestedBy: 'user-1',
  });

  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  player.getProgressSeconds = () => 108;
  player.queue.current = track;
  player.playing = true;

  await player._handleTrackClose(track, 0, null);

  const resumedTrack = player.pendingTracks[0] as ({ recoveryAttemptCount?: number } & Record<string, unknown>) | undefined;

  assert.equal(playCalls, 1);
  assert.equal(resumedTrack?.title, track.title);
  assert.equal(resumedTrack?.seekStartSec, 106);
  assert.equal(resumedTrack?.recoveryAttemptCount, 1);
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Track pipeline closed earlier than expected'
    && meta?.autoRecoveryScheduled === true
    && meta?.recoverySeekSec === 106
    && meta?.sourceCode === null
  )));
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Scheduling automatic playback recovery after early track close'
    && meta?.recoveryTrigger === 'pipeline_close'
    && meta?.backend === 'local'
    && meta?.recoverySeekSec === 106
  )));
});

test('_handleTrackClose auto-recovers early-ended NodeLink tracks with NodeLink retry first', async () => {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const player = new MusicPlayer(createVoice(), {
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });

  const track = player.createTrackFromData({
    title: 'NodeLink YouTube Track',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    duration: '03:40',
    source: 'youtube',
    requestedBy: 'user-1',
    nodelinkEncodedTrack: 'encoded-node-track',
    nodelinkInfo: { sourceName: 'youtube' },
  });

  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  player.getProgressSeconds = () => 32;
  player.queue.current = track;
  player.playing = true;

  await player._handleTrackClose(track, 0, null);

  const resumedTrack = player.pendingTracks[0] as ({ recoveryAttemptCount?: number; nodelinkEncodedTrack?: unknown } & Record<string, unknown>) | undefined;

  assert.equal(playCalls, 1);
  assert.equal(resumedTrack?.title, track.title);
  assert.equal(resumedTrack?.seekStartSec, 30);
  assert.equal(resumedTrack?.recoveryAttemptCount, 1);
  assert.equal(resumedTrack?.nodelinkEncodedTrack ?? null, 'encoded-node-track');
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Scheduling automatic playback recovery after early track close'
    && meta?.backend === 'nodelink-retry'
    && meta?.recoverySeekSec === 30
  )));
});

test('_handleTrackClose second NodeLink early-close retry falls back to local pipeline', async () => {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const player = new MusicPlayer(createVoice(), {
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });

  const track = player.createTrackFromData({
    title: 'NodeLink Retry Track',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    duration: '03:40',
    source: 'youtube',
    requestedBy: 'user-1',
    nodelinkEncodedTrack: 'encoded-node-track',
    nodelinkInfo: { sourceName: 'youtube' },
  }) as ({ recoveryAttemptCount?: number } & ReturnType<MusicPlayer['createTrackFromData']>);
  track.recoveryAttemptCount = 1;

  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  player.getProgressSeconds = () => 36;
  player.queue.current = track;
  player.playing = true;

  await player._handleTrackClose(track, 0, null);

  const resumedTrack = player.pendingTracks[0] as ({ recoveryAttemptCount?: number; nodelinkEncodedTrack?: unknown } & Record<string, unknown>) | undefined;

  assert.equal(playCalls, 1);
  assert.equal(resumedTrack?.title, track.title);
  assert.equal(resumedTrack?.seekStartSec, 34);
  assert.equal(resumedTrack?.recoveryAttemptCount, 2);
  assert.equal(resumedTrack?.nodelinkEncodedTrack ?? null, null);
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Scheduling automatic playback recovery after early track close'
    && meta?.backend === 'nodelink-local-fallback'
    && meta?.recoverySeekSec === 34
  )));
});





