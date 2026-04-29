import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

function buildJoinCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('join');
}

test('join resolves voice channel through async fallback', async () => {
  const join = buildJoinCommand();
  const execute = join?.execute;
  assert.ok(execute);
  const calls: string[] = [];

  await execute({
    guildId: 'guild-1',
    channelId: 'text-1',
    args: [],
    prefix: '!',
    config: { prefix: '!' },
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    rest: {},
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        calls.push('resolveMemberVoiceChannel');
        return null;
      },
      async resolveMemberVoiceChannelWithFallback() {
        calls.push('resolveMemberVoiceChannelWithFallback');
        return 'voice-1';
      },
    },
    sessions: {
      has() {
        calls.push('has');
        return false;
      },
      async ensure() {
        calls.push('ensure');
        return {
          guildId: 'guild-1',
          connection: {
            connected: false,
            async connect(channelId: string) {
              calls.push(`connect:${channelId}`);
            },
          },
        };
      },
      bindTextChannel(guildId: string, channelId: string) {
        calls.push(`bind:${guildId}:${channelId}`);
      },
      async destroy() {},
    },
    reply: {
      async success() {
        calls.push('reply');
      },
    },
  });

  assert.deepEqual(calls, [
    'resolveMemberVoiceChannel',
    'resolveMemberVoiceChannelWithFallback',
    'has',
    'ensure',
    'connect:voice-1',
    'reply',
  ]);
  assert.equal(calls.includes('bind:guild-1:text-1'), false);
});





