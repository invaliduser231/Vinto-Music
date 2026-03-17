import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';

function buildJoinCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('join');
}

test('join rejects when guild already reached the max concurrent voice-session limit', async () => {
  const join = buildJoinCommand();

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
      has(_guildId, selector) {
        return selector?.voiceChannelId === 'voice-1';
      },
      listByGuild() {
        return [
          { sessionId: 'guild-1:voice-1' },
          { sessionId: 'guild-1:voice-2' },
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
    () => join.execute(ctx),
    /maximum number of active voice sessions \(2\)/i
  );
});
