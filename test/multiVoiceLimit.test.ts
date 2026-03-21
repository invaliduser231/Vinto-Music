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

test('join rejects when guild already reached the max concurrent voice-session limit', async () => {
  const join = buildJoinCommand();
  const execute = join?.execute as JoinExecute | undefined;
  assert.ok(execute);

  const ctx = {
    guildId: 'guild-1',
    channelId: 'text-1',
    args: [],
    prefix: '!',
    config: {
      prefix: '!',
      maxConcurrentVoiceChannelsPerGuild: 2,
    },
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-3';
      },
    },
    sessions: {
      has(_guildId: string, selector: { voiceChannelId?: string }) {
        return selector?.voiceChannelId === 'voice-1';
      },
      listByGuild() {
        return [
          { sessionId: 'guild-1:voice-1', connection: { channelId: 'voice-1' } },
          { sessionId: 'guild-1:voice-2', connection: { channelId: 'voice-2' } },
        ];
      },
      async ensure() {
        throw new Error('should not create a new session');
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
    /maximum number of active voice sessions \(2\)/i
  );
});

test('join ignores preview sessions when enforcing the concurrent voice-session limit', async () => {
  const join = buildJoinCommand();
  const execute = join?.execute as JoinExecute | undefined;
  assert.ok(execute);
  const ensureCalls: Array<{ voiceChannelId: string }> = [];

  const ctx = {
    guildId: 'guild-1',
    channelId: 'text-1',
    args: [],
    prefix: '!',
    guildConfig: {
      guildId: 'guild-1',
      settings: {},
    },
    config: {
      prefix: '!',
      maxConcurrentVoiceChannelsPerGuild: 2,
    },
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-2';
      },
    },
    sessions: {
      has() {
        return false;
      },
      listByGuild() {
        return [
          { sessionId: 'guild-1:preview' },
          { sessionId: 'guild-1:voice-1', connection: { channelId: 'voice-1' } },
        ];
      },
      async ensure(_guildId: string, _guildConfig: unknown, options: { voiceChannelId: string }) {
        ensureCalls.push(options);
        return {
          connection: {
            connected: true,
            channelId: options.voiceChannelId,
            hasUsablePlayer() {
              return true;
            },
          },
        };
      },
      bindTextChannel() {},
      adoptVoiceChannel() {},
      async syncPersistentVoiceState() {},
      async destroy() {},
    },
    reply: {
      async success() {},
    },
  };

  await execute(ctx);

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0]!.voiceChannelId, 'voice-2');
});






