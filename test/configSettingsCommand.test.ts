import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { registerCommands } from '../src/bot/commands/index.ts';

type SettingsExecute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

test('settings command shows 24/7 status with the active voice channel tag', async () => {
  const registry = new CommandRegistry();
  registerCommands(registry);

  const command = registry.resolve('settings');
  assert.ok(command);
  const execute = command.execute as SettingsExecute;

  let replyTitle = '';
  let replyFields: Array<{ name: string; value: string; inline?: boolean }> = [];

  await execute({
    guildId: '111111',
    args: [],
    config: {
      defaultStayInVoiceEnabled: false,
      prefix: '!',
    },
    sessions: {
      get() {
        return {
          connection: { channelId: '222222' },
          settings: { stayInVoiceEnabled: true },
        };
      },
    },
    reply: {
      async info(title: string, fields: Array<{ name: string; value: string; inline?: boolean }>) {
        replyTitle = title;
        replyFields = fields;
      },
    },
    library: {
      async getVoiceProfile() {
        return { stayInVoiceEnabled: true };
      },
    },
    voiceStateStore: null,
    message: {
      guild_id: '111111',
      author: { id: '444444' },
      member: { permissions: '32' },
    },
    rest: {},
    prefix: '!',
    channelId: '333333',
    activeVoiceChannelId: '222222',
    guildConfigs: {
      async get() {
        return {
          guildId: '111111',
          prefix: '!',
          settings: {
            stayInVoiceEnabled: false,
            earrapeProtectionEnabled: true,
            minimalMode: false,
            dedupeEnabled: false,
            volumePercent: 100,
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

  assert.equal(replyTitle, 'Guild configuration');
  const stayField = replyFields.find((field) => field.name === '24/7');
  assert.ok(stayField);
  assert.equal(stayField.value, '<#222222>: on');
  const earrapeField = replyFields.find((field) => field.name === 'Earrape Protection');
  assert.ok(earrapeField);
  assert.equal(earrapeField.value, 'on (bot undeafens)');
});
