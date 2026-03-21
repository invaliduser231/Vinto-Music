import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

type JoinExecute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

function buildJoinCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('join');
}

test('join rejects when bot lacks voice channel permissions', async () => {
  const join = buildJoinCommand();
  const execute = join?.execute as JoinExecute | undefined;
  assert.ok(execute);

  const ctx = {
    guildId: 'guild-1',
    channelId: 'text-1',
    args: [],
    prefix: '!',
    config: { prefix: '!' },
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-1';
      },
    },
    permissionService: {
      async canBotJoinAndSpeak() {
        return false;
      },
    },
    sessions: {
      has() {
        return false;
      },
      async ensure() {
        throw new Error('should not be called');
      },
      bindTextChannel() {},
      async destroy() {},
    },
    reply: {
      async success() {},
    },
  };

  await assert.rejects(
    async () => execute(ctx),
    /do not have permission to connect and speak/
  );
});



