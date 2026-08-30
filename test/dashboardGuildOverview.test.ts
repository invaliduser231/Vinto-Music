import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGuildOverviewPayload } from '../src/dashboard/sessionSnapshot.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';
import type { Session } from '../src/types/domain.ts';

test('buildGuildOverviewPayload includes user voice channel and active sessions', () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
    ['user-2', 'vc-2'],
  ]));

  const sessions = [
    {
      guildId: 'guild-1',
      connection: { channelId: 'vc-1' },
      targetVoiceChannelId: 'vc-1',
      player: { playing: true, currentTrack: { title: 'Live' } },
    },
    {
      guildId: 'guild-1',
      connection: { channelId: 'vc-3' },
      targetVoiceChannelId: 'vc-3',
      player: { playing: false, currentTrack: null },
    },
  ] as Session[];

  const payload = buildGuildOverviewPayload({
    guildId: 'guild-1',
    guildName: 'Guild One',
    sessions,
    voiceStateStore,
    botUserId: 'bot-1',
    userId: 'user-1',
  });

  assert.equal(payload.userVoiceChannelId, 'vc-1');
  assert.equal(payload.voiceChannels.length, 1);
  assert.equal(payload.voiceChannels[0]?.id, 'vc-1');
  assert.equal(payload.voiceChannels[0]?.active, true);
});

test('buildGuildOverviewPayload hides voice channels when user is not in voice', () => {
  const voiceStateStore = new VoiceStateStore();
  const sessions = [{
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    player: { playing: true, currentTrack: { title: 'Live' } },
  }] as Session[];

  const payload = buildGuildOverviewPayload({
    guildId: 'guild-1',
    guildName: 'Guild One',
    sessions,
    voiceStateStore,
    botUserId: 'bot-1',
    userId: 'user-1',
  });

  assert.equal(payload.userVoiceChannelId, null);
  assert.equal(payload.voiceChannels.length, 0);
});
