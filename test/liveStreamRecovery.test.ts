import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';
import type { Track } from '../src/types/domain.ts';

type RecoveryFields = { recoveryAttemptCount?: number; recoveryWindowStartedAtMs?: number };
type LoggedWarning = { message: string; meta: Record<string, unknown> | undefined };

function createPlayer(warnings: LoggedWarning[] = []) {
  return new MusicPlayer({
    connected: true,
    channelId: 'voice-1',
    async sendAudio() {},
  }, {
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });
}

function radioTrack(player: MusicPlayer) {
  return player.createTrackFromData({
    title: 'Fun Radio',
    url: 'https://streaming-ice.audiomeans.fr/rtl/feed-funradio-mp3-128',
    duration: 'Live',
    source: 'radio-stream',
    isLive: true,
  }) as Track & RecoveryFields;
}

function markPlaying(player: MusicPlayer, track: Track) {
  player.queue.current = track;
  player.playing = true;
  player.getProgressSeconds = () => 3600;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function ffmpegHttpArgs(player: MusicPlayer, url: string, isLive: boolean): string[] {
  const typed = player as unknown as {
    _ffmpegHttpArgs: (inputUrl: string, seekSec: number, options: { isLive?: boolean }) => string[];
  };
  return typed._ffmpegHttpArgs(url, 0, { isLive });
}

test('live ffmpeg input reconnects on resets and read stalls', () => {
  const player = createPlayer();
  const args = ffmpegHttpArgs(player, 'https://radio.example/stream', true);
  const inputIndex = args.indexOf('-i');

  for (const option of ['-reconnect', '-reconnect_streamed', '-reconnect_on_network_error', '-rw_timeout']) {
    const index = args.indexOf(option);
    assert.ok(index >= 0 && index < inputIndex, `${option} must be an input option`);
  }
  assert.equal(args[args.indexOf('-rw_timeout') + 1], '15000000');
});

test('regular http tracks keep the plain ffmpeg input', () => {
  const player = createPlayer();
  const args = ffmpegHttpArgs(player, 'https://cdn.example/track.mp3', false);

  assert.equal(args.includes('-reconnect'), false);
  assert.equal(args.includes('-rw_timeout'), false);
});

test('an ended radio stream is restarted after a short delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const warnings: LoggedWarning[] = [];
  const player = createPlayer(warnings);
  const track = radioTrack(player);
  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  markPlaying(player, track);
  player.liveStreamStderrTail = 'Stream ends prematurely at 51200\n[http] Connection reset by peer\n';

  const closing = player._handleTrackClose(track, 0, null);
  await settle();
  assert.equal(playCalls, 0);

  t.mock.timers.tick(1_000);
  await closing;

  const restarted = player.pendingTracks[0] as (Track & RecoveryFields) | undefined;
  assert.equal(playCalls, 1);
  assert.equal(restarted?.title, 'Fun Radio');
  assert.equal(restarted?.recoveryAttemptCount, 1);
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'Live stream ended, reconnecting'
    && meta?.delayMs === 1_000
    && meta?.ffmpegStderrTail === 'Stream ends prematurely at 51200 | [http] Connection reset by peer'
  )));
});

test('the restart delay grows with each attempt inside the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const warnings: LoggedWarning[] = [];
  const player = createPlayer(warnings);
  const track = radioTrack(player);
  track.recoveryAttemptCount = 3;
  track.recoveryWindowStartedAtMs = 1_000_000 - 60_000;
  player.play = async () => {};
  markPlaying(player, track);

  const closing = player._handleTrackClose(track, 0, null);
  await settle();
  t.mock.timers.tick(8_000);
  await closing;

  assert.ok(warnings.some(({ message, meta }) => message === 'Live stream ended, reconnecting' && meta?.delayMs === 8_000));
});

test('a radio stream that keeps ending gives up after five restarts', async () => {
  const warnings: LoggedWarning[] = [];
  const player = createPlayer(warnings);
  const track = radioTrack(player);
  track.recoveryAttemptCount = 5;
  track.recoveryWindowStartedAtMs = Date.now() - 60_000;
  let queueEmpty = 0;
  player.on('queueEmpty', () => {
    queueEmpty += 1;
  });
  markPlaying(player, track);

  await player._handleTrackClose(track, 0, null);

  assert.equal(player.pendingTracks.length, 0);
  assert.equal(queueEmpty, 1);
  assert.ok(warnings.some(({ message }) => message === 'Live stream kept ending, giving up'));
});

test('skipping or stopping a radio stream never restarts it', async () => {
  const player = createPlayer();
  const track = radioTrack(player);
  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  markPlaying(player, track);
  player.skipRequested = true;

  await player._handleTrackClose(track, 0, null);

  assert.equal(playCalls, 0);
  assert.equal(player.pendingTracks.length, 0);
});

test('a stop during the restart delay cancels the restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const player = createPlayer();
  const track = radioTrack(player);
  let playCalls = 0;
  player.play = async () => {
    playCalls += 1;
  };
  markPlaying(player, track);

  const closing = player._handleTrackClose(track, 0, null);
  await settle();
  player.stop();
  t.mock.timers.tick(1_000);
  await closing;

  assert.equal(playCalls, 0);
  assert.equal(player.pendingTracks.length, 0);
});
