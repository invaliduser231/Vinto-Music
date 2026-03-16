import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.js';

function createPlayer() {
  return new MusicPlayer({}, {
    logger: null,
    ytdlpYoutubeClient: 'web',
  });
}

function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killCalls = [];
  proc.kill = (signal) => {
    proc.killCalls.push(signal);
  };
  return proc;
}

test('yt-dlp startup retries clean up failed attempt processes before retrying', async () => {
  const player = createPlayer();
  const firstSourceProc = createFakeProcess();
  const firstFfmpeg = createFakeProcess();
  const secondSourceProc = createFakeProcess();
  const secondFfmpeg = createFakeProcess();
  const spawned = [];

  player._spawnYtDlp = async (_url, _formatSelector, includeClientArg) => {
    const proc = includeClientArg ? firstSourceProc : secondSourceProc;
    spawned.push(proc);
    return proc;
  };

  player._spawnProcess = async () => {
    const proc = spawned.length === 1 ? firstFfmpeg : secondFfmpeg;
    return proc;
  };

  let awaitCalls = 0;
  player._awaitProcessOutput = async (proc) => {
    awaitCalls += 1;
    if (proc === firstSourceProc) {
      throw new Error('yt-dlp did not produce audio output in time.');
    }
  };

  await player._startYtDlpPipeline('https://www.youtube.com/watch?v=demo1234567', 0);

  assert.equal(awaitCalls, 2);
  assert.deepEqual(firstSourceProc.killCalls, ['SIGKILL']);
  assert.deepEqual(firstFfmpeg.killCalls, ['SIGKILL']);
  assert.equal(player.sourceProc, secondSourceProc);
  assert.equal(player.ffmpeg, secondFfmpeg);
});

test('yt-dlp seek startup prefers direct media URL pipeline before pipe-based fallback', async () => {
  const player = createPlayer();
  const ffmpeg = createFakeProcess();
  let resolvedUrlCalls = 0;
  let pipeFallbackCalls = 0;

  player._resolveYtDlpStreamUrl = async () => {
    resolvedUrlCalls += 1;
    return 'https://media.example.com/audio.m4a';
  };
  player._spawnProcess = async (_cmd, args) => {
    assert.ok(args.includes('https://media.example.com/audio.m4a'));
    assert.ok(args.includes('-ss'));
    return ffmpeg;
  };
  player._startYtDlpPipelineWithFormat = async () => {
    pipeFallbackCalls += 1;
  };

  await player._startYtDlpPipeline('https://www.youtube.com/watch?v=demo1234567', 120);

  assert.equal(resolvedUrlCalls, 1);
  assert.equal(pipeFallbackCalls, 0);
  assert.equal(player.ffmpeg, ffmpeg);
  assert.equal(player.sourceProc, null);
});

test('yt-dlp seek startup falls back to pipe-based startup when direct media URL resolution fails', async () => {
  const player = createPlayer();
  let directAttempts = 0;
  let pipeFallbackCalls = 0;

  player._resolveYtDlpStreamUrl = async () => {
    directAttempts += 1;
    throw new Error('direct URL blocked');
  };
  player._startYtDlpPipelineWithFormat = async () => {
    pipeFallbackCalls += 1;
  };

  await player._startYtDlpPipeline('https://www.youtube.com/watch?v=demo1234567', 120);

  assert.equal(directAttempts, 3);
  assert.equal(pipeFallbackCalls, 1);
});
