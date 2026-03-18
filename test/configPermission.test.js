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
      volumePercent: 100,
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

test('config command allows message-role fallback when getGuildMember fails', async () => {
  const dedupe = buildDedupeCommand();
  let replied = false;

  await dedupe.execute({
    guildId: 'guild-3',
    authorId: 'user-3',
    args: [],
    message: {
      guild_id: 'guild-3',
      author: { id: 'user-3' },
      member: { roles: ['role-admin'] },
    },
    rest: {
      async getGuildMember() {
        throw new Error('member lookup failed');
      },
      async getGuild() {
        throw new Error('guild lookup failed');
      },
      async listGuildRoles() {
        return [{ id: 'role-admin', permissions: '8' }];
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

test('config command allows gateway guild-state cache fallback without REST role access', async () => {
  const dedupe = buildDedupeCommand();
  let replied = false;

  await dedupe.execute({
    guildId: 'guild-4',
    authorId: 'user-4',
    args: [],
    message: {
      guild_id: 'guild-4',
      author: { id: 'user-4' },
      member: { roles: ['role-admin'] },
    },
    guildStateCache: {
      resolveOwnerId() {
        return 'owner-4';
      },
      computeManageGuildPermission(guildId, roleIds, userId) {
        assert.equal(guildId, 'guild-4');
        assert.deepEqual(roleIds, ['role-admin']);
        assert.equal(userId, 'user-4');
        return true;
      },
    },
    rest: {
      async getGuildMember() {
        return {
          user: { id: 'user-4' },
          roles: ['role-admin'],
        };
      },
      async getGuild() {
        throw new Error('guild lookup failed');
      },
      async listGuildRoles() {
        throw new Error('roles lookup failed');
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

test('config command reports role-list access problems clearly', async () => {
  const dedupe = buildDedupeCommand();

  await assert.rejects(
    () => dedupe.execute({
      guildId: 'guild-5',
      authorId: 'user-5',
      args: [],
      message: {
        guild_id: 'guild-5',
        author: { id: 'user-5' },
        member: { roles: ['role-admin'] },
      },
      rest: {
        async getGuildMember() {
          return {
            user: { id: 'user-5' },
            roles: ['role-admin'],
          };
        },
        async getGuild() {
          throw Object.assign(new Error('guild failed'), { status: 500 });
        },
        async listGuildRoles() {
          throw Object.assign(new Error('roles denied'), { status: 403 });
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
    /denied the bot access to this server's role list/
  );
});
