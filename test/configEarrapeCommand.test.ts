import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { registerCommands } from '../src/bot/commands/index.ts';

type EarrapeExecute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

function buildGuildConfig(earrapeProtectionEnabled = false) {
  return {
    guildId: '111111',
    prefix: '!',
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      earrapeProtectionEnabled,
      minimalMode: false,
      volumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: [],
      musicLogChannelId: null,
    },
  };
}

test('earrape command toggles guild protection and applies the update to active sessions', async () => {
  const registry = new CommandRegistry();
  registerCommands(registry);

  const command = registry.resolve('earrape');
  assert.ok(command);
  const execute = command.execute as EarrapeExecute;
  const calls: Array<[string, ...unknown[]]> = [];

  await execute({
    guildId: '111111',
    authorId: '444444',
    args: ['on'],
    message: {
      guild_id: '111111',
      author: { id: '444444' },
      member: { permissions: '32' },
    },
    guildConfigs: {
      async get() {
        return buildGuildConfig(false);
      },
      async update(guildId: string, patch: { settings?: { earrapeProtectionEnabled?: boolean } }) {
        calls.push(['update', guildId, patch.settings?.earrapeProtectionEnabled ?? null]);
        return buildGuildConfig(Boolean(patch.settings?.earrapeProtectionEnabled));
      },
    },
    sessions: {
      applyGuildConfig(guildId: string, config: { settings?: { earrapeProtectionEnabled?: boolean } }) {
        calls.push(['apply', guildId, config.settings?.earrapeProtectionEnabled ?? null]);
      },
    },
    reply: {
      async success(message: string) {
        calls.push(['reply', message]);
      },
    },
  } as unknown);

  assert.deepEqual(calls, [
    ['update', '111111', true],
    ['apply', '111111', true],
    ['reply', 'Earrape protection is now **on**.'],
  ]);
});

test('earrape command reports the current state when no value is provided', async () => {
  const registry = new CommandRegistry();
  registerCommands(registry);

  const command = registry.resolve('earrape');
  assert.ok(command);
  const execute = command.execute as EarrapeExecute;
  let replyMessage = '';

  await execute({
    guildId: '111111',
    authorId: '444444',
    args: [],
    message: {
      guild_id: '111111',
      author: { id: '444444' },
      member: { permissions: '32' },
    },
    guildConfigs: {
      async get() {
        return buildGuildConfig(true);
      },
    },
    sessions: {
      applyGuildConfig() {},
    },
    reply: {
      async info(message: string) {
        replyMessage = message;
      },
    },
  } as unknown);

  assert.equal(replyMessage, 'Earrape protection is currently **on**.');
});

test('earrape command rejects enabling when bot lacks move members in active voice channel', async () => {
  const registry = new CommandRegistry();
  registerCommands(registry);

  const command = registry.resolve('earrape');
  assert.ok(command);
  const execute = command.execute as EarrapeExecute;

  await assert.rejects(
    async () => execute({
      guildId: '111111',
      authorId: '444444',
      activeVoiceChannelId: '222222',
      channelId: '333333',
      args: ['on'],
      message: {
        guild_id: '111111',
        author: { id: '444444' },
        member: { permissions: '32' },
      },
      guildConfigs: {
        async get() {
          return buildGuildConfig(false);
        },
      },
      permissionService: {
        async canBotMoveMembers() {
          return false;
        },
      },
      sessions: {
        applyGuildConfig() {},
        get() {
          return null;
        },
        listByGuild() {
          return [{
            connection: {
              channelId: '222222',
            },
          }];
        },
      },
      reply: {
        async success() {},
      },
    } as unknown),
    /Move Members/
  );
});
