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
