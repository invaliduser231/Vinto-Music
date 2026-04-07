import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { SessionManager } from '../src/bot/sessionManager.ts';

function buildVolumeCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('volume');
}

function buildVolumeDefaultCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('volumedefault');
}

test('volume command only changes the active session volume', async () => {
  const volume = buildVolumeCommand();
  const executeVolume = volume?.execute;
  assert.ok(executeVolume);
  const updates: Array<{ guildId: string; patch: { settings: { volumePercent: number } } }> = [];
  const dirty: Array<[string, boolean]> = [];

  await executeVolume({
    guildId: 'guild-1',
    authorId: 'user-1',
    args: ['35'],
    guildConfigs: {
      async update(guildId: string, patch: { settings: { volumePercent: number } }) {
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
      markSnapshotDirty(session: { connection: { channelId: string } }, force: boolean) {
        dirty.push([session.connection.channelId, force]);
      },
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

  assert.deepEqual(updates, []);
  assert.deepEqual(dirty, [['voice-1', true]]);
});

test('volume change enables live processing without restarting the current track', () => {
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
    logger: undefined,
    voiceStateStore: null,
    botUserId: null,
  });

  return manager.ensure('guild-1').then(async (session) => {
    const player = session.player as typeof session.player & {
      _enableLiveAudioProcessorDuringPlayback: () => boolean;
      refreshCurrentTrackProcessing: () => boolean;
      liveAudioProcessor?: unknown;
      setVolumePercent: (value: number) => number;
    };
    manager._clearIdleTimer(session);
    player.playing = true;
    let enableCalls = 0;
    let refreshCalls = 0;
    player._enableLiveAudioProcessorDuringPlayback = () => {
      enableCalls += 1;
      return true;
    };
    player.refreshCurrentTrackProcessing = () => {
      refreshCalls += 1;
      return true;
    };

    assert.equal(player.volumePercent, 100);
    assert.equal(player.liveAudioProcessor ?? null, null);

    player.setVolumePercent(5);

    assert.equal(player.volumePercent, 5);
    assert.equal(enableCalls, 1);
    assert.equal(refreshCalls, 0);

    await manager.destroy('guild-1', 'test');
  });
});

test('volume default command persists guild default volume', async () => {
  const volumeDefault = buildVolumeDefaultCommand();
  const executeVolumeDefault = volumeDefault?.execute;
  assert.ok(executeVolumeDefault);
  const updates: Array<{ guildId: string; patch: { settings: { volumePercent: number } } }> = [];

  await executeVolumeDefault({
    guildId: 'guild-1',
    authorId: 'user-1',
    args: ['35'],
    guildConfig: {
      guildId: 'guild-1',
      prefix: '!',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 2,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
    guildConfigs: {
      async update(guildId: string, patch: { settings: { volumePercent: number } }) {
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
      applyGuildConfig() {},
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
    logger: undefined,
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





