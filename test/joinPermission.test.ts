import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { createTranslator } from '../src/i18n/index.ts';

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
      async checkBotPermissions(_guildId: string, _channelId: string, required: readonly string[]) {
        return {
          known: true,
          bits: 0n,
          reason: null,
          source: 'computed',
          isOwner: false,
          isAdministrator: false,
          ok: false,
          missing: [...required],
          required: [...required],
        };
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
    t: createTranslator('en'),
    reply: {
      async success() {},
    },
  };

  await assert.rejects(
    async () => execute(ctx),
    (err: Error) => {
      assert.match(err.message, /<#voice-1>/, 'names the affected voice channel');
      assert.match(err.message, /View Channel/, 'names the missing view permission');
      assert.match(err.message, /Connect/, 'names the missing connect permission');
      assert.match(err.message, /Speak/, 'names the missing speak permission');
      return true;
    }
  );
});



