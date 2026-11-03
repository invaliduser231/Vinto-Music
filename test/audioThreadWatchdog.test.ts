import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  countAudioCaptureThreads,
  evaluateAudioThreadWatchdog,
  leakedAudioThreads,
} from '../src/app/audioThreadWatchdog.ts';

const policy = { idleRestartLeakedThreads: 150, restartLeakedThreads: 400 };

test('capture threads backing live connections are not counted as leaked', () => {
  const sample = { captureThreads: 40, voiceConnectionsConnected: 40, playersPlaying: 30 };

  assert.equal(leakedAudioThreads(sample), 0);
  assert.equal(evaluateAudioThreadWatchdog(policy, sample), 'ok');
});

test('the idle threshold only applies while nothing is playing', () => {
  const playing = { captureThreads: 200, voiceConnectionsConnected: 25, playersPlaying: 3 };
  const idle = { ...playing, playersPlaying: 0 };

  assert.equal(evaluateAudioThreadWatchdog(policy, playing), 'ok');
  assert.equal(evaluateAudioThreadWatchdog(policy, idle), 'breach_idle');
});

test('the hard threshold applies during playback', () => {
  const sample = { captureThreads: 430, voiceConnectionsConnected: 25, playersPlaying: 20 };

  assert.equal(evaluateAudioThreadWatchdog(policy, sample), 'breach');
});

test('a zero threshold disables that check', () => {
  const sample = { captureThreads: 5_000, voiceConnectionsConnected: 0, playersPlaying: 0 };

  assert.equal(evaluateAudioThreadWatchdog({ idleRestartLeakedThreads: 0, restartLeakedThreads: 0 }, sample), 'ok');
});

test('countAudioCaptureThreads counts threads by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vinto-tasks-'));
  try {
    const threads = ['MainThread', 'AudioSourceCapt', 'AudioSourceCapt', 'tokio-rt-worker'];
    await Promise.all(threads.map(async (name, index) => {
      await mkdir(join(dir, String(index)));
      await writeFile(join(dir, String(index), 'comm'), `${name}\n`);
    }));

    assert.equal(await countAudioCaptureThreads(dir), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('countAudioCaptureThreads returns null without a task directory', async () => {
  assert.equal(await countAudioCaptureThreads(join(tmpdir(), 'vinto-missing-task-dir')), null);
});
