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

function createPlayer() {
  return new MusicPlayer({}, {
    logger: null,
    ytdlpYoutubeClient: 'web',
  });
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

test('yt-dlp startup retries clean up failed attempt processes before retrying', async () => {
  const player = createPlayer();
  const firstSourceProc = createFakeProcess();
  const firstFfmpeg = createFakeProcess();
  const secondSourceProc = createFakeProcess();
  const secondFfmpeg = createFakeProcess();
  const spawned = [];

  player._spawnYtDlp = async (_url: string, _formatSelector: string | null, includeClientArg: boolean) => {
    const proc = includeClientArg ? firstSourceProc : secondSourceProc;
    spawned.push(proc);
    return proc;
  };

  player._spawnProcess = async () => {
    const proc = spawned.length === 1 ? firstFfmpeg : secondFfmpeg;
    return proc;
  };

  let awaitCalls = 0;
  player._awaitProcessOutput = async (proc: FakeProcess) => {
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

test('yt-dlp seek startup uses pipe-based startup path', async () => {
  const player = createPlayer();
  let pipeStartupCalls = 0;

  player._startYtDlpPipelineWithFormat = async (_url: string, seekSec: number) => {
    pipeStartupCalls += 1;
    assert.equal(seekSec, 120);
  };

  await player._startYtDlpPipeline('https://www.youtube.com/watch?v=demo1234567', 120);

  assert.equal(pipeStartupCalls, 1);
});

test('yt-dlp seek startup retries pipe-based startup strategies directly', async () => {
  const player = createPlayer();
  const attemptedClients: boolean[] = [];
  player._startYtDlpPipelineWithFormat = async (_url: string, _seekSec: number, _format: string | null, includeClientArg: boolean) => {
    attemptedClients.push(includeClientArg);
    if (attemptedClients.length < 3) {
      throw new Error('pipe startup failed');
    }
  };

  await player._startYtDlpPipeline('https://www.youtube.com/watch?v=demo1234567', 120);

  assert.deepEqual(attemptedClients, [true, false, false]);
});





