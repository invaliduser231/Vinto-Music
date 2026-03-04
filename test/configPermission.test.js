import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';

function buildDedupeCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('dedupe');
}

function baseGuildConfig() {
  return {
    guildId: 'guild-1',
    prefix: '!',
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: [],
      musicLogChannelId: null,
    },
  };
}

test('config command allows users with manage guild permission', async () => {
  const dedupe = buildDedupeCommand();
  let replied = false;

  await dedupe.execute({
    guildId: 'guild-1',
    args: [],
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
      member: { permissions: '32' },
    },
    guildConfigs: {
      async get() {
        return baseGuildConfig();
      },
      async update() {
        throw new Error('update should not be called');
      },
    },
    sessions: {
      applyGuildConfig() {},
    },
    reply: {
      async info() {
        replied = true;
      },
    },
  });

  assert.equal(replied, true);
});

test('config command rejects users without manage guild permission', async () => {
  const dedupe = buildDedupeCommand();

  await assert.rejects(
    () => dedupe.execute({
      guildId: 'guild-1',
      args: [],
      message: {
        guild_id: 'guild-1',
        author: { id: 'user-1' },
        member: { permissions: '0' },
      },
      guildConfigs: {
        async get() {
          return baseGuildConfig();
        },
      },
      sessions: {
        applyGuildConfig() {},
      },
      reply: {
        async info() {},
      },
    }),
    /Manage Server/
  );
});

test('config command allows REST role-based manage guild fallback', async () => {
  const dedupe = buildDedupeCommand();
  let replied = false;

  await dedupe.execute({
    guildId: 'guild-1',
    authorId: 'user-1',
    args: [],
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
      member: { roles: ['role-1'] },
    },
    rest: {
      async getGuildMember() {
        return { user: { id: 'user-1' }, roles: ['role-1'] };
      },
      async getGuild() {
        return { id: 'guild-1', owner_id: 'owner-1' };
      },
      async listGuildRoles() {
        return [{ id: 'role-1', permissions: '32' }];
      },
    },
    guildConfigs: {
      async get() {
        return baseGuildConfig();
      },
    },
    sessions: {
      applyGuildConfig() {},
    },
    reply: {
      async info() {
        replied = true;
      },
    },
  });

  assert.equal(replied, true);
});

test('config command rejects REST role fallback without manage guild bit', async () => {
  const dedupe = buildDedupeCommand();

  await assert.rejects(
    () => dedupe.execute({
      guildId: 'guild-2',
      authorId: 'user-2',
      args: [],
      message: {
        guild_id: 'guild-2',
        author: { id: 'user-2' },
        member: { roles: ['role-1'] },
      },
      rest: {
        async getGuildMember() {
          return { user: { id: 'user-2' }, roles: ['role-1'] };
        },
        async getGuild() {
          return { id: 'guild-2', owner_id: 'owner-1' };
        },
        async listGuildRoles() {
          return [{ id: 'role-1', permissions: '0' }];
        },
      },
      guildConfigs: {
        async get() {
          return baseGuildConfig();
        },
      },
      sessions: {
        applyGuildConfig() {},
      },
      reply: {
        async info() {},
      },
    }),
    /Manage Server/
  );
});
