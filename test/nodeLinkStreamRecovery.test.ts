import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';
import { describeErrorCause } from '../src/player/musicPlayer/processUtils.ts';
import type { Track } from '../src/types/domain.ts';

const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;

type RecoveryFields = { recoveryAttemptCount?: number; recoveryWindowStartedAtMs?: number };
type LoggedWarning = { message: string; meta: Record<string, unknown> | undefined };

function createPlayer(warnings: LoggedWarning[] = []) {
  return new MusicPlayer({
    connected: true,
    channelId: 'voice-1',
    async sendAudio() {},
  }, {
    nodeLinkEnabled: true,
    nodeLinkBaseUrl: 'http://nodelink:3000',
    nodeLinkPassword: 'secret',
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  });
}

function longEpisode(player: MusicPlayer) {
  return player.createTrackFromData({
    title: 'Episode 138',
    url: 'https://soundcloud.com/vibe-digital/episode138',
    duration: '1:59:51',
    source: 'soundcloud',
    requestedBy: 'user-1',
    nodelinkEncodedTrack: 'encoded-episode',
    nodelinkInfo: { sourceName: 'soundcloud' },
  }) as Track & RecoveryFields;
}

function markPlaying(player: MusicPlayer, track: Track, clockSeconds: number) {
  player.play = async () => {};
  player.getProgressSeconds = () => clockSeconds;
  player.queue.current = track;
  player.playing = true;
}

test('recovery resumes from the audio that actually arrived, not from the wall clock', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  markPlaying(player, track, 2026);
  player.currentTrackOffsetSec = 0;
  player.receivedPcmBytes = 1705 * PCM_BYTES_PER_SECOND;

  await player._handleTrackClose(track, 0, null);

  const resumed = player.pendingTracks[0] as (Track & RecoveryFields) | undefined;
  assert.equal(resumed?.seekStartSec, 1703);
  assert.equal(resumed?.recoveryAttemptCount, 1);
});

test('the received audio position counts from the seek offset of the stream', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  markPlaying(player, track, 2100);
  player.currentTrackOffsetSec = 2024;
  player.receivedPcmBytes = 60 * PCM_BYTES_PER_SECOND;

  await player._handleTrackClose(track, 0, null);

  assert.equal(player.pendingTracks[0]?.seekStartSec, 2082);
});

test('recovery falls back to the wall clock when no audio was counted', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  markPlaying(player, track, 900);
  player.receivedPcmBytes = null;

  await player._handleTrackClose(track, 0, null);

  assert.equal(player.pendingTracks[0]?.seekStartSec, 898);
});

test('recovery attempts expire after the recovery window', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  track.recoveryAttemptCount = 2;
  track.recoveryWindowStartedAtMs = Date.now() - 11 * 60_000;
  markPlaying(player, track, 4855);

  const before = Date.now();
  await player._handleTrackClose(track, 0, null);

  const resumed = player.pendingTracks[0] as (Track & RecoveryFields) | undefined;
  assert.equal(resumed?.recoveryAttemptCount, 1);
  assert.ok((resumed?.recoveryWindowStartedAtMs ?? 0) >= before);
});

test('repeated failures inside the window still stop after the attempt limit', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  track.recoveryAttemptCount = 2;
  track.recoveryWindowStartedAtMs = Date.now() - 60_000;
  markPlaying(player, track, 4855);

  await player._handleTrackClose(track, 0, null);

  assert.equal(player.pendingTracks.length, 0);
});

test('a recovery inside the window keeps the original window start', async () => {
  const player = createPlayer();
  const track = longEpisode(player);
  const windowStart = Date.now() - 2 * 60_000;
  track.recoveryAttemptCount = 1;
  track.recoveryWindowStartedAtMs = windowStart;
  markPlaying(player, track, 3000);

  await player._handleTrackClose(track, 0, null);

  const resumed = player.pendingTracks[0] as (Track & RecoveryFields) | undefined;
  assert.equal(resumed?.recoveryAttemptCount, 2);
  assert.equal(resumed?.recoveryWindowStartedAtMs, windowStart);
});

async function startStalledStream(player: MusicPlayer, stream: PassThrough) {
  const closedTracks: string[] = [];
  player.nodeLinkClient = {
    enabled: true,
    streamTrack: async () => stream,
  } as unknown as MusicPlayer['nodeLinkClient'];
  player._awaitInitialPlaybackChunk = async () => {};
  player._drainPlaybackBeforeClose = async () => {};
  player._handleTrackClose = async (track: Track) => {
    closedTracks.push(String(track.title));
  };

  await player._startNodeLinkStream(longEpisode(player), player.playbackStartupToken ?? 0, 0);
  stream.write(Buffer.alloc(2 * PCM_BYTES_PER_SECOND));
  await new Promise((resolve) => setImmediate(resolve));
  return closedTracks;
}

test('a NodeLink stream that stops delivering audio is torn down so recovery can start', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const warnings: LoggedWarning[] = [];
  const player = createPlayer(warnings);
  const stream = new PassThrough();

  const closedTracks = await startStalledStream(player, stream);
  assert.equal(player.receivedPcmBytes, 2 * PCM_BYTES_PER_SECOND);

  t.mock.timers.tick(10_000);
  assert.equal(stream.destroyed, false);

  t.mock.timers.tick(4_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stream.destroyed, true);
  assert.deepEqual(closedTracks, ['Episode 138']);
  assert.ok(warnings.some(({ message, meta }) => (
    message === 'NodeLink stream stalled, restarting from the last received position'
    && meta?.receivedPcmBytes === 2 * PCM_BYTES_PER_SECOND
  )));
  player.stop();
});

test('a paused player does not count as a stalled NodeLink stream', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const player = createPlayer();
  const stream = new PassThrough();

  const closedTracks = await startStalledStream(player, stream);
  player.paused = true;

  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stream.destroyed, false);
  assert.deepEqual(closedTracks, []);
  player.stop();
});

test('describeErrorCause reports the code and message of the underlying error', () => {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });

  assert.equal(
    describeErrorCause(new TypeError('terminated', { cause: socketError })),
    'UND_ERR_SOCKET: other side closed',
  );
  assert.equal(describeErrorCause(new Error('plain')), null);
});
