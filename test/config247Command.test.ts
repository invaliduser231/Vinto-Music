import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { registerCommands } from '../src/bot/commands/index.ts';

type Command247Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

test('247 command resolves required helpers through command registration', async () => {
  const registry = new CommandRegistry();
  registerCommands(registry);

  const command = registry.resolve('247');
  assert.ok(command);
  const execute = command.execute as Command247Execute;
  assert.ok(execute);

  const calls: Array<[string, ...unknown[]]> = [];
  await execute({
    guildId: '111111',
    args: ['on'],
    config: {
      defaultStayInVoiceEnabled: false,
      prefix: '!',
    },
    sessions: {
      async refreshVoiceProfileSettings(guildId: string, selector: { voiceChannelId?: string }) {
        calls.push(['refresh', guildId, selector.voiceChannelId]);
      },
    },
    reply: {
      async success(message: string) {
        calls.push(['reply', message]);
      },
    },
    library: {
      async getVoiceProfile() {
        return null;
      },
      async setVoiceProfile(guildId: string, channelId: string, patch: { stayInVoiceEnabled?: boolean }) {
        calls.push(['set', guildId, channelId, patch.stayInVoiceEnabled]);
      },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return '222222';
      },
    },
    message: {
      guild_id: '111111',
      author: { id: '444444' },
      member: { permissions: '32' },
    },
    rest: {},
    prefix: '!',
    channelId: '333333',
    guildConfigs: {
      async get() {
        return {
          guildId: '111111',
          settings: {
            stayInVoiceEnabled: false,
            dedupeEnabled: false,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    authorId: '444444',
    permissionService: null,
  });

  assert.deepEqual(calls, [
    ['set', '111111', '222222', true],
    ['refresh', '111111', '222222'],
    ['reply', '24/7 mode for <#222222> is now **on**.'],
  ]);
});





