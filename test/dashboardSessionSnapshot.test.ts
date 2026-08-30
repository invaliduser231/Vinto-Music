import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrackDurationSeconds } from '../src/dashboard/duration.ts';
import {
  buildGuildDashboardSessionPayload,
  serializeTrack,
  userHasDjAccessForSession,
} from '../src/dashboard/sessionSnapshot.ts';
import type { Session, Track } from '../src/types/domain.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

test('parseTrackDurationSeconds reads mm:ss labels', () => {
  assert.equal(parseTrackDurationSeconds('3:45'), 225);
  assert.equal(parseTrackDurationSeconds('1:02:03'), 3723);
});

test('serializeTrack keeps stable ids and artist fallback', () => {
  const track: Track = {
    title: 'Test song',
    url: 'https://example.com/track',
    duration: '2:10',
    source: 'deezer',
  };
  const payload = serializeTrack(track, 1);
  assert.equal(payload.title, 'Test song');
  assert.equal(payload.artist, 'Unknown artist');
  assert.equal(payload.durationSec, 130);
  assert.equal(payload.id, 'https://example.com/track');
  assert.equal(payload.url, 'https://example.com/track');
});

test('userHasDjAccessForSession allows everyone when no dj roles are set', () => {
  const session = {
    settings: { djRoleIds: new Set<string>(), autoplayEnabled: true },
  } as Session;
  assert.equal(userHasDjAccessForSession(session, 'user-1', []), true);
});

test('buildGuildDashboardSessionPayload marks control only inside the voice channel', () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const track: Track = {
    title: 'Playing',
    url: 'https://example.com/now',
    duration: '3:00',
    source: 'deezer',
    artist: 'Artist',
  };

  const player = {
    currentTrack: track,
    pendingTracks: [],
    playing: true,
    paused: false,
    loopMode: 'off',
    volumePercent: 80,
    getProgressSeconds: () => 42,
    filterPreset: 'soft',
    eqPreset: 'vocal',
    tempoRatio: 0.95,
    pitchSemitones: -1,
  };

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>(), autoplayEnabled: true },
    player,
  } as Session;

  const inChannel = buildGuildDashboardSessionPayload({
    guildId: 'guild-1',
    guildName: 'Guild 1',
    sessions: [session],
    voiceChannelId: 'vc-1',
    userId: 'user-1',
    roleIds: [],
    voiceStateStore,
    botUserId: 'bot-1',
  });

  const outsideChannel = buildGuildDashboardSessionPayload({
    guildId: 'guild-1',
    guildName: 'Guild 1',
    sessions: [session],
    voiceChannelId: 'vc-1',
    userId: 'user-2',
    roleIds: [],
    voiceStateStore,
    botUserId: 'bot-1',
  });

  assert.equal(inChannel?.canControl, true);
  assert.equal(inChannel?.autoplayEnabled, true);
  assert.equal(inChannel?.nowPlaying?.positionSec, 42);
  assert.deepEqual(inChannel?.effects, {
    filterPreset: 'soft',
    eqPreset: 'vocal',
    tempoRatio: 0.95,
    pitchSemitones: -1,
  });
  assert.deepEqual(inChannel?.voteSkip, { votes: 0, required: 2 });
  assert.equal(outsideChannel?.canControl, false);
  assert.equal(outsideChannel?.nowPlaying, null);
  assert.equal(outsideChannel?.queue.length, 0);
});
