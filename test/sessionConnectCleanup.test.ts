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

function createBaseContext(overrides: Record<string, unknown> = {}) {
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
  const execute = join?.execute as JoinExecute | undefined;
  assert.ok(execute);
  const calls: Array<[string, ...unknown[]]> = [];

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
      async destroy(guildId: string, reason: string) {
        calls.push(['destroy', guildId, reason]);
        return true;
      },
    },
  });

  await assert.rejects(async () => execute(ctx), /connect failed/);
  assert.deepEqual(calls, [
    ['has'],
    ['ensure'],
    ['connect'],
    ['destroy', 'guild-1', 'connect_failed'],
  ]);
});

test('join does not destroy existing session when reconnect fails', async () => {
  const join = buildJoinCommand();
  const execute = join?.execute as JoinExecute | undefined;
  assert.ok(execute);
  const calls: Array<[string, ...unknown[]]> = [];

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
      async destroy(guildId: string, reason: string) {
        calls.push(['destroy', guildId, reason]);
        return true;
      },
    },
  });

  await assert.rejects(async () => execute(ctx), /connect failed/);
  assert.deepEqual(calls, [
    ['has'],
    ['ensure'],
    ['connect'],
  ]);
});






