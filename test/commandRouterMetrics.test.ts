import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppMetrics } from '../src/app/metrics.ts';
import { CommandRouter } from '../src/bot/commandRouter.ts';

function createRouter() {
  const metrics = createAppMetrics();
  const router = new CommandRouter({
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
      async editMessage() {},
      async sendMessage() { return { id: 'message-1' }; },
    },
    gateway: {
      on() {},
      off() {},
    },
    sessions: {
      on() {},
      sessions: new Map(),
      has() { return false; },
      bindTextChannel() { return null; },
      get() { return null; },
      destroy() { return Promise.resolve(null); },
    } as ConstructorParameters<typeof CommandRouter>[0]['sessions'],
    guildConfigs: null,
    voiceStateStore: {
      resolveMemberVoiceChannel() { return null; },
      countUsersInChannel() { return 1; },
    },
    lyrics: null,
    library: null,
    permissionService: null,
    botUserId: 'bot-1',
    startedAt: Date.now(),
    metrics,
  } as ConstructorParameters<typeof CommandRouter>[0]);

  return { metrics, router };
}

function cleanupRouter(router: CommandRouter) {
  if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
  if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
}

test('unknown commands share a single metrics label bucket', async () => {
  const { metrics, router } = createRouter();

  try {
    await router.handleMessage({
      content: '!definitely-not-a-real-command',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      author: { id: 'user-1', bot: false },
    });
    await router.handleMessage({
      content: '!another-made-up-command',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      author: { id: 'user-2', bot: false },
    });
  } finally {
    cleanupRouter(router);
  }

  assert.equal(metrics.commandsTotal.samples.size, 1);
  const sample = [...metrics.commandsTotal.samples.values()][0];
  assert.deepEqual(sample?.labels, {
    command: 'unknown',
    outcome: 'unknown',
  });
  assert.equal(sample?.value, 2);
});
