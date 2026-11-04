import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CommandRouter } from '../src/bot/commandRouter.ts';

function createRouter(sessions: EventEmitter) {
  return new CommandRouter({
    config: {
      prefix: '!',
      enableEmbeds: true,
      commandRateLimitEnabled: false,
      commandUserWindowMs: 10_000,
      commandUserMax: 10,
      commandGuildWindowMs: 10_000,
      commandGuildMax: 100,
      commandRateLimitBypass: [],
      sessionIdleMs: 300_000,
    },
    rest: {
      async sendTyping() {},
      async sendMessage() {
        return { id: 'message-1' };
      },
      async editMessage() {},
    },
    gateway: {
      on() {},
      off() {},
    },
    sessions: sessions as unknown as ConstructorParameters<typeof CommandRouter>[0]['sessions'],
    guildConfigs: null,
    voiceStateStore: {
      countUsersInChannel() {
        return 1;
      },
    },
    lyrics: null,
    library: null,
    permissionService: null,
    botUserId: 'bot-1',
    startedAt: Date.now(),
  } as ConstructorParameters<typeof CommandRouter>[0]);
}

async function emitDestroyed(reason: string) {
  const sessions = new EventEmitter();
  const router = createRouter(sessions);
  const calls: Array<{ channelId: string; type: string; text: string }> = [];

  router._safeReply = (async (channelId: string, type: string, text: string) => {
    calls.push({ channelId, type, text });
    return null;
  }) as CommandRouter['_safeReply'];

  try {
    sessions.emit('destroyed', {
      session: {
        sessionId: 'session-1',
        guildId: 'guild-1',
        textChannelId: 'text-1',
        connection: { channelId: 'voice-1' },
        settings: {},
      },
      reason,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
    if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
  }

  return calls;
}

test('shutdown does not announce a closed session', async () => {
  assert.deepEqual(await emitDestroyed('shutdown'), []);
});

test('other destroy reasons still announce the closed session', async () => {
  assert.deepEqual(await emitDestroyed('voice_kicked'), [{
    channelId: 'text-1',
    type: 'warning',
    text: 'Session closed (voice_kicked).',
  }]);
});
