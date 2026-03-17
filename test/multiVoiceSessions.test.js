import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.js';

function createManager() {
  return new SessionManager({
    gateway: {
      joinVoice() {},
      leaveVoice() {},
      on() {},
      off() {},
    },
    config: {
      sessionIdleMs: 10_000,
      defaultDedupeEnabled: false,
      defaultStayInVoiceEnabled: false,
      defaultVolumePercent: 100,
      minVolumePercent: 0,
      maxVolumePercent: 200,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      voiceMaxBitrate: 192000,
      maxQueueSize: 100,
      maxPlaylistTracks: 25,
      enableYtSearch: true,
      enableYtPlayback: true,
      enableSpotifyImport: true,
      enableDeezerImport: true,
      youtubePlaylistResolver: 'ytdlp',
    },
    logger: null,
    guildConfigs: null,
    voiceStateStore: null,
    botUserId: null,
  });
}

test('session manager keeps separate sessions per voice channel in the same guild', async () => {
  const manager = createManager();

  const first = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-a' });
  const second = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-b' });

  manager._clearIdleTimer(first);
  manager._clearIdleTimer(second);

  assert.notEqual(first, second);
  assert.equal(manager.listByGuild('guild-1').length, 2);
  assert.equal(manager.get('guild-1', { voiceChannelId: 'voice-a' }), first);
  assert.equal(manager.get('guild-1', { voiceChannelId: 'voice-b' }), second);
  assert.equal(manager.get('guild-1'), null);
});

test('destroying one voice-channel session leaves the others intact', async () => {
  const manager = createManager();

  const first = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-a' });
  const second = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-b' });

  manager._clearIdleTimer(first);
  manager._clearIdleTimer(second);

  const removed = await manager.destroy('guild-1', 'manual_command', { voiceChannelId: 'voice-a' });

  assert.equal(removed, true);
  assert.equal(manager.get('guild-1', { voiceChannelId: 'voice-a' }), null);
  assert.equal(manager.get('guild-1', { voiceChannelId: 'voice-b' }), second);
  assert.equal(manager.listByGuild('guild-1').length, 1);
});
