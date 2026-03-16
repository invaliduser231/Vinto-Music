import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';
import { SessionManager } from '../src/bot/sessionManager.js';

function buildVolumeCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('volume');
}

test('volume command persists guild volume setting', async () => {
  const volume = buildVolumeCommand();
  const updates = [];

  await volume.execute({
    guildId: 'guild-1',
    authorId: 'user-1',
    args: ['35'],
    guildConfigs: {
      async update(guildId, patch) {
        updates.push({ guildId, patch });
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            volumePercent: patch.settings.volumePercent,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    sessions: {
      get() {
        return {
          settings: {
            djRoleIds: new Set(),
          },
          connection: {
            channelId: 'voice-1',
          },
          player: {
            volumePercent: 100,
            setVolumePercent() {
              return 35;
            },
          },
        };
      },
      applyGuildConfig() {},
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-1';
      },
      countUsersInChannel() {
        return 1;
      },
    },
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
      member: { permissions: '32' },
    },
    reply: {
      async success() {},
    },
  });

  assert.deepEqual(updates, [{
    guildId: 'guild-1',
    patch: {
      settings: {
        volumePercent: 35,
      },
    },
  }]);
});

test('session manager uses stored guild volume for new sessions and updates active players', async () => {
  const manager = new SessionManager({
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
    guildConfigs: {
      async get() {
        return {
          guildId: 'guild-1',
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            volumePercent: 35,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    logger: null,
    voiceStateStore: null,
    botUserId: null,
  });

  const session = await manager.ensure('guild-1');
  manager._clearIdleTimer(session);

  assert.equal(session.player.volumePercent, 35);
  assert.equal(session.settings.volumePercent, 35);

  manager.applyGuildConfig('guild-1', {
    guildId: 'guild-1',
    prefix: '!',
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      volumePercent: 55,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: [],
      musicLogChannelId: null,
    },
  });

  assert.equal(session.player.volumePercent, 55);
  assert.equal(session.settings.volumePercent, 55);

  await manager.destroy('guild-1', 'test');
});
