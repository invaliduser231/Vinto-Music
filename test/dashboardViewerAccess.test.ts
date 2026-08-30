import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyViewerRestrictions,
  filterVoiceChannelsForUser,
  getUserVoiceChannelId,
} from '../src/dashboard/viewerAccess.ts';
import type { DashboardSessionPayload } from '../src/dashboard/sessionSnapshot.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

function samplePayload(overrides: Partial<DashboardSessionPayload> = {}): DashboardSessionPayload {
  return {
    guildId: 'guild-1',
    guildName: 'Guild 1',
    voiceChannelId: 'vc-1',
    voiceChannelName: 'General',
    userInChannel: true,
    canControl: true,
    autoplayEnabled: false,
    nowPlaying: {
      id: 'track-1',
      url: 'https://example.com/track-1',
      title: 'Song',
      artist: 'Artist',
      durationSec: 180,
      positionSec: 30,
      paused: false,
      loopMode: 'off',
      volumePercent: 100,
      seekable: true,
      thumbnailUrl: null,
      source: 'deezer',
      requestedBy: 'user-1',
      requestedByName: null,
      requestedByAvatarUrl: null,
    },
    queue: [{
      id: 'track-2',
      url: 'https://example.com/track-2',
      title: 'Next',
      artist: 'Artist',
      durationSec: 200,
      thumbnailUrl: null,
      source: 'deezer',
      requestedBy: 'user-1',
      requestedByName: null,
      requestedByAvatarUrl: null,
    }],
    voiceChannels: [
      { id: 'vc-1', name: 'General', active: true, listenerCount: 2 },
      { id: 'vc-2', name: 'Other', active: false, listenerCount: 0 },
    ],
    listeners: [
      { id: 'user-1', name: 'Requester', avatarUrl: null, isBot: false },
      { id: 'user-2', name: 'Listener', avatarUrl: null, isBot: false },
    ],
    effects: {
      filterPreset: 'off',
      eqPreset: 'flat',
      tempoRatio: 1,
      pitchSemitones: 0,
    },
    voteSkip: { votes: 0, required: 2 },
    handoff: null,
    ...overrides,
  };
}

test('getUserVoiceChannelId reads voice state for guild member', () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  assert.equal(getUserVoiceChannelId(voiceStateStore, 'guild-1', 'user-1'), 'vc-1');
  assert.equal(getUserVoiceChannelId(voiceStateStore, 'guild-1', 'user-2'), null);
});

test('applyViewerRestrictions hides playback data outside the user voice channel', () => {
  const restricted = applyViewerRestrictions(samplePayload(), 'vc-2');
  assert.equal(restricted.userInChannel, false);
  assert.equal(restricted.canControl, false);
  assert.equal(restricted.nowPlaying, null);
  assert.equal(restricted.queue.length, 0);
  assert.equal(restricted.listeners.length, 0);
  assert.deepEqual(restricted.voiceChannels.map((entry) => entry.id), ['vc-2']);
});

test('applyViewerRestrictions keeps playback data inside the user voice channel', () => {
  const allowed = applyViewerRestrictions(samplePayload(), 'vc-1');
  assert.equal(allowed.userInChannel, true);
  assert.equal(allowed.canControl, true);
  assert.equal(allowed.nowPlaying?.title, 'Song');
  assert.equal(allowed.queue.length, 1);
  assert.deepEqual(allowed.listeners.map((entry) => entry.id), ['user-1', 'user-2']);
  assert.deepEqual(allowed.voiceChannels.map((entry) => entry.id), ['vc-1']);
});

test('filterVoiceChannelsForUser only exposes the member channel', () => {
  const filtered = filterVoiceChannelsForUser([
    { id: 'vc-1', name: 'General', active: true, listenerCount: 2 },
    { id: 'vc-2', name: 'Other', active: false, listenerCount: 0 },
  ], 'vc-1');
  assert.deepEqual(filtered.map((entry) => entry.id), ['vc-1']);
});
