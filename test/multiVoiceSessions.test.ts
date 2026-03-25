import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SessionManager } from '../src/bot/sessionManager.ts';

function createManager() {
  const gateway = new EventEmitter() as EventEmitter & {
    joinVoice: () => void;
    leaveVoice: () => void;
  };
  gateway.joinVoice = () => {};
  gateway.leaveVoice = () => {};

  return new SessionManager({
    gateway,
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
    botUserId: 'bot-1',
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

test('external bot disconnect destroys lingering guild voice sessions', async () => {
  const manager = createManager();

  const first = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-a' });
  const second = await manager.ensure('guild-1', null, { voiceChannelId: 'voice-b' });

  first.connection.channelId = 'voice-a';
  second.connection.channelId = 'voice-b';
  manager._clearIdleTimer(first);
  manager._clearIdleTimer(second);

  const destroyed: string[] = [];
  manager.on('destroyed', (payload: { session?: { sessionId?: string | null } }) => {
    if (payload?.session?.sessionId) {
      destroyed.push(String(payload.session.sessionId));
    }
  });

  manager.gateway.emit('VOICE_STATE_UPDATE', {
    guild_id: 'guild-1',
    user_id: 'bot-1',
    channel_id: null,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(destroyed.sort(), ['guild-1:voice-a', 'guild-1:voice-b']);
  assert.equal(manager.listByGuild('guild-1').length, 0);
});





