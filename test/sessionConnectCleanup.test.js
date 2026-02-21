import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';

function buildJoinCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('join');
}

function createBaseContext(overrides = {}) {
  return {
    guildId: 'guild-1',
    channelId: 'text-1',
    args: [],
    message: {
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-1';
      },
    },
    sessions: {
      has() {
        return false;
      },
      ensure() {
        return {
          guildId: 'guild-1',
          connection: {
            connected: false,
            async connect() {
              throw new Error('connect failed');
            },
          },
        };
      },
      bindTextChannel() {},
      async destroy() {
        return true;
      },
    },
    reply: {
      async success() {},
    },
    ...overrides,
  };
}

test('join destroys newly created session if connect fails', async () => {
  const join = buildJoinCommand();
  const calls = [];

  const ctx = createBaseContext({
    sessions: {
      has() {
        calls.push(['has']);
        return false;
      },
      ensure() {
        calls.push(['ensure']);
        return {
          guildId: 'guild-1',
          connection: {
            connected: false,
            async connect() {
              calls.push(['connect']);
              throw new Error('connect failed');
            },
          },
        };
      },
      bindTextChannel(guildId, channelId) {
        calls.push(['bindTextChannel', guildId, channelId]);
      },
      async destroy(guildId, reason) {
        calls.push(['destroy', guildId, reason]);
        return true;
      },
    },
  });

  await assert.rejects(() => join.execute(ctx), /connect failed/);
  assert.deepEqual(calls, [
    ['has'],
    ['ensure'],
    ['bindTextChannel', 'guild-1', 'text-1'],
    ['connect'],
    ['destroy', 'guild-1', 'connect_failed'],
  ]);
});

test('join does not destroy existing session when reconnect fails', async () => {
  const join = buildJoinCommand();
  const calls = [];

  const ctx = createBaseContext({
    sessions: {
      has() {
        calls.push(['has']);
        return true;
      },
      ensure() {
        calls.push(['ensure']);
        return {
          guildId: 'guild-1',
          connection: {
            connected: false,
            async connect() {
              calls.push(['connect']);
              throw new Error('connect failed');
            },
          },
        };
      },
      bindTextChannel(guildId, channelId) {
        calls.push(['bindTextChannel', guildId, channelId]);
      },
      async destroy(guildId, reason) {
        calls.push(['destroy', guildId, reason]);
        return true;
      },
    },
  });

  await assert.rejects(() => join.execute(ctx), /connect failed/);
  assert.deepEqual(calls, [
    ['has'],
    ['ensure'],
    ['bindTextChannel', 'guild-1', 'text-1'],
    ['connect'],
  ]);
});
