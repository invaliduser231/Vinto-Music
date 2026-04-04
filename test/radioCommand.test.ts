import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { listAvailableRadioStations } from '../src/bot/commands/helpers/radioStations.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

function buildRegistry() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry;
}

test('radio command resolves a built-in station preset and starts playback', async () => {
  const registry = buildRegistry();
  const radio = registry.resolve('radio');
  const execute = radio?.execute as Execute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  const connection = {
    connected: false,
    async connect(channelId: string) {
      calls.push(`connect:${channelId}`);
      connection.connected = true;
    },
    hasUsablePlayer() {
      return true;
    },
  };

  await execute({
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: 'user-1',
    args: ['Groove Salad'],
    prefix: '!',
    config: {
      prefix: '!',
      enableEmbeds: true,
      maxConcurrentVoiceChannelsPerGuild: 5,
    },
    message: {
      id: 'message-1',
      guild_id: '1474874137937518680',
      author: { id: 'user-1' },
    },
    guildConfig: {
      guildId: '1474874137937518680',
      prefix: '!',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 1,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
    library: {
      async listGuildStations() {
        return [];
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
    sessions: {
      has() {
        return false;
      },
      listByGuild() {
        return [];
      },
      async ensure() {
        return {
          guildId: '1474874137937518680',
          sessionId: 'session-1',
          connection,
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 1,
            djRoleIds: new Set<string>(),
          },
          player: {
            playing: false,
            currentTrack: null,
            async previewTracks(query: string) {
              playerCalls.push(`preview:${query}`);
              return [{
                title: 'Groove Salad',
                duration: 'Live',
                url: query,
                source: 'radio-stream',
                isLive: true,
              }];
            },
            createTrackFromData(track: Record<string, unknown>, requestedBy: string) {
              playerCalls.push(`create:${requestedBy}`);
              return { ...track, requestedBy };
            },
            enqueueResolvedTracks(tracks: Record<string, unknown>[], options: Record<string, unknown>) {
              playerCalls.push(`enqueue:${JSON.stringify(options)}`);
              return tracks;
            },
            async play() {
              playerCalls.push('play');
            },
            skip() {
              playerCalls.push('skip');
              return true;
            },
          },
        };
      },
      bindTextChannel() {},
      applyGuildConfig() {},
      async destroy() {},
      adoptVoiceChannel() {},
      async syncPersistentVoiceState() {},
      markSnapshotDirty() {
        calls.push('snapshot');
      },
    },
    rest: {
      async sendMessage() {
        calls.push('sendMessage');
        return { id: 'progress-1' };
      },
      async editMessage(_channelId: string, _messageId: string, payload: { embeds?: Array<{ description?: string }>; content?: string }) {
        calls.push(`edit:${payload?.embeds?.[0]?.description ?? payload?.content ?? ''}`);
        return { id: 'progress-1' };
      },
    },
    reply: {
      async info(text: string) {
        calls.push(`reply:info:${text}`);
      },
      async success(text: string) {
        calls.push(`reply:success:${text}`);
      },
      async warning(text: string) {
        calls.push(`reply:warning:${text}`);
      },
      async error(text: string) {
        calls.push(`reply:error:${text}`);
      },
    },
    async safeTyping() {
      calls.push('typing');
    },
    async withGuildOpLock(_label: string, task: () => Promise<unknown>) {
      calls.push('lock');
      return task();
    },
  });

  assert.ok(playerCalls.includes('preview:https://somafm.com/groovesalad.pls'));
  assert.ok(playerCalls.includes('play'));
  assert.ok(calls.includes('snapshot'));
  assert.ok(calls.some((entry) => entry.includes('Tuning into')));
});

test('radio command accepts a numeric index from the visible station order', async () => {
  const registry = buildRegistry();
  const radio = registry.resolve('radio');
  const execute = radio?.execute as Execute | undefined;
  assert.ok(execute);

  const expected = listAvailableRadioStations([])[0];
  assert.ok(expected);

  let previewQuery: string | null = null;

  await execute({
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: 'user-1',
    args: ['1'],
    prefix: '#',
    config: {
      prefix: '#',
      enableEmbeds: true,
      maxConcurrentVoiceChannelsPerGuild: 5,
    },
    message: {
      id: 'message-1',
      guild_id: '1474874137937518680',
      author: { id: 'user-1' },
    },
    guildConfig: {
      guildId: '1474874137937518680',
      prefix: '#',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 1,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
    library: {
      async listGuildStations() {
        return [];
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
    sessions: {
      has() {
        return false;
      },
      listByGuild() {
        return [];
      },
      async ensure() {
        return {
          guildId: '1474874137937518680',
          sessionId: 'session-1',
          connection: {
            connected: false,
            async connect() {},
            hasUsablePlayer() {
              return true;
            },
          },
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 1,
            djRoleIds: new Set<string>(),
          },
          player: {
            playing: false,
            currentTrack: null,
            async previewTracks(query: string) {
              previewQuery = query;
              return [{
                title: expected.name,
                duration: 'Live',
                url: query,
                source: 'radio-stream',
                isLive: true,
              }];
            },
            createTrackFromData(track: Record<string, unknown>, requestedBy: string) {
              return { ...track, requestedBy };
            },
            enqueueResolvedTracks(tracks: Record<string, unknown>[]) {
              return tracks;
            },
            async play() {},
            skip() {
              return true;
            },
          },
        };
      },
      bindTextChannel() {},
      applyGuildConfig() {},
      async destroy() {},
      adoptVoiceChannel() {},
      async syncPersistentVoiceState() {},
      markSnapshotDirty() {},
    },
    rest: {
      async sendMessage() {
        return { id: 'progress-1' };
      },
      async editMessage() {
        return { id: 'progress-1' };
      },
    },
    reply: {
      async info() {},
      async success() {},
      async warning() {},
      async error() {},
    },
    async safeTyping() {},
    async withGuildOpLock(_label: string, task: () => Promise<unknown>) {
      return task();
    },
  });

  assert.equal(previewQuery, expected.url);
});

test('radio command resolves keyword searches to the best matching station', async () => {
  const registry = buildRegistry();
  const radio = registry.resolve('radio');
  const execute = radio?.execute as Execute | undefined;
  assert.ok(execute);

  let previewQuery: string | null = null;

  await execute({
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: 'user-1',
    args: ['lofi'],
    prefix: '#',
    config: {
      prefix: '#',
      enableEmbeds: true,
      maxConcurrentVoiceChannelsPerGuild: 5,
    },
    message: {
      id: 'message-1',
      guild_id: '1474874137937518680',
      author: { id: 'user-1' },
    },
    guildConfig: {
      guildId: '1474874137937518680',
      prefix: '#',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 1,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
    library: {
      async listGuildStations() {
        return [];
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
    sessions: {
      has() {
        return false;
      },
      listByGuild() {
        return [];
      },
      async ensure() {
        return {
          guildId: '1474874137937518680',
          sessionId: 'session-1',
          connection: {
            connected: false,
            async connect() {},
            hasUsablePlayer() {
              return true;
            },
          },
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 1,
            djRoleIds: new Set<string>(),
          },
          player: {
            playing: false,
            currentTrack: null,
            async previewTracks(query: string) {
              previewQuery = query;
              return [{
                title: 'Groove Salad',
                duration: 'Live',
                url: query,
                source: 'radio-stream',
                isLive: true,
              }];
            },
            createTrackFromData(track: Record<string, unknown>, requestedBy: string) {
              return { ...track, requestedBy };
            },
            enqueueResolvedTracks(tracks: Record<string, unknown>[]) {
              return tracks;
            },
            async play() {},
            skip() {
              return true;
            },
          },
        };
      },
      bindTextChannel() {},
      applyGuildConfig() {},
      async destroy() {},
      adoptVoiceChannel() {},
      async syncPersistentVoiceState() {},
      markSnapshotDirty() {},
    },
    rest: {
      async sendMessage() {
        return { id: 'progress-1' };
      },
      async editMessage() {
        return { id: 'progress-1' };
      },
    },
    reply: {
      async info() {},
      async success() {},
      async warning() {},
      async error() {},
    },
    async safeTyping() {},
    async withGuildOpLock(_label: string, task: () => Promise<unknown>) {
      return task();
    },
  });

  assert.equal(previewQuery, 'https://somafm.com/groovesalad.pls');
});
