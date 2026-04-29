import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

function buildRegistry() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry;
}

function createBaseContext(overrides: Record<string, unknown> = {}) {
  const replyCalls: string[] = [];
  const context = {
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: '123456',
    args: [],
    prefix: '!',
    config: {
      prefix: '!',
      maxConcurrentVoiceChannelsPerGuild: 5,
    },
    message: {
      guild_id: '1474874137937518680',
      author: { id: '123456' },
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
        return true;
      },
      listByGuild() {
        return [{
          targetVoiceChannelId: 'voice-1',
        }];
      },
      async ensure() {
        return {
          guildId: '1474874137937518680',
          sessionId: 'session-1',
          textChannelId: 'text-1',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 1,
            djRoleIds: new Set<string>(),
          },
          connection: {
            connected: true,
            channelId: 'voice-1',
            async connect() {},
            hasUsablePlayer() {
              return true;
            },
          },
          player: {
            playing: false,
            createTrackFromData(track: Record<string, unknown>, requestedBy: string) {
              return { ...track, requestedBy };
            },
            enqueueResolvedTracks(tracks: Record<string, unknown>[]) {
              return tracks;
            },
            async play() {},
          },
        };
      },
      bindTextChannel() {},
      async destroy() {},
    },
    reply: {
      async info(text: string, fields?: Array<{ name: string; value: string }>) {
        replyCalls.push(`info:${text}:${fields?.[0]?.value ?? ''}`);
      },
      async success(text: string) {
        replyCalls.push(`success:${text}`);
      },
      async warning(text: string) {
        replyCalls.push(`warning:${text}`);
      },
      async error(text: string) {
        replyCalls.push(`error:${text}`);
      },
    },
    sendPaginated: async () => {},
    ...overrides,
  };

  return { context, replyCalls };
}

test('favname command renames favorite alias', async () => {
  const registry = buildRegistry();
  const command = registry.resolve('favname');
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute);

  let calledWith: { userId: string; index: number; alias: string } | null = null;
  const { context, replyCalls } = createBaseContext({
    args: ['1', 'Roadtrip Mix'],
    library: {
      async renameUserFavorite(userId: string, index: number, alias: string) {
        calledWith = { userId, index, alias };
        return {
          title: 'Track One',
          url: 'https://example.com/track-1',
          duration: '3:00',
          source: 'youtube',
          alias,
        };
      },
    },
  });

  await execute(context);

  assert.deepEqual(calledWith, {
    userId: '123456',
    index: 1,
    alias: 'Roadtrip Mix',
  });
  assert.ok(replyCalls.some((entry) => entry.includes('success:Updated favorite alias: **Roadtrip Mix**')));
});

test('favs command shows alias in favorites list', async () => {
  const registry = buildRegistry();
  const command = registry.resolve('favs');
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute);

  const { context, replyCalls } = createBaseContext({
    library: {
      async listUserFavorites() {
        return {
          items: [{
            title: 'Track One',
            url: 'https://example.com/track-1',
            duration: '3:00',
            source: 'youtube',
            requestedBy: '123456',
            alias: 'Roadtrip Mix',
          }],
          page: 1,
          pageSize: 10,
          total: 1,
          totalPages: 1,
        };
      },
    },
  });

  await execute(context);

  assert.ok(replyCalls.some((entry) => entry.includes('1. Roadtrip Mix (3:00)')));
});

test('favs command falls back to song title when alias is missing', async () => {
  const registry = buildRegistry();
  const command = registry.resolve('favs');
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute);

  const { context, replyCalls } = createBaseContext({
    library: {
      async listUserFavorites() {
        return {
          items: [{
            title: 'Fernweh',
            url: 'https://example.com/track-1',
            duration: '2:48',
            source: 'youtube',
            requestedBy: '123456',
          }],
          page: 1,
          pageSize: 10,
          total: 1,
          totalPages: 1,
        };
      },
    },
  });

  await execute(context);

  assert.ok(replyCalls.some((entry) => entry.includes('1. Fernweh (2:48)')));
});

test('favplay accepts alias selector', async () => {
  const registry = buildRegistry();
  const command = registry.resolve('favplay');
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute);

  let aliasLookup = '';
  const { context, replyCalls } = createBaseContext({
    args: ['Roadtrip', 'Mix'],
    library: {
      async getUserFavoriteByAlias(_userId: string, alias: string) {
        aliasLookup = alias;
        return {
          title: 'Track One',
          url: 'https://example.com/track-1',
          duration: '3:00',
          source: 'youtube',
        };
      },
      async getUserFavorite() {
        throw new Error('index lookup should not run for alias selector');
      },
    },
  });

  await execute(context);

  assert.equal(aliasLookup, 'Roadtrip Mix');
  assert.ok(replyCalls.some((entry) => entry.includes('success:Added favorite to queue: **Track One** (3:00)')));
});

test('favplay warns when alias is not found', async () => {
  const registry = buildRegistry();
  const command = registry.resolve('favplay');
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute);

  const { context, replyCalls } = createBaseContext({
    args: ['Missing Alias'],
    library: {
      async getUserFavoriteByAlias() {
        return null;
      },
      async getUserFavorite() {
        return null;
      },
    },
  });

  await execute(context);

  assert.ok(replyCalls.some((entry) => entry.includes('warning:Favorite alias not found.')));
});
