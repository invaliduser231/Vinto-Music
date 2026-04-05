import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

function createRouter(restOverrides: Record<string, unknown> = {}) {
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
      async editMessage() {},
      async sendMessage() { return { id: 'message-1' }; },
      ...restOverrides,
    } as ConstructorParameters<typeof CommandRouter>[0]['rest'],
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
  } as ConstructorParameters<typeof CommandRouter>[0]);
}

function cleanupRouter(router: CommandRouter) {
  if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
  if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
}

test('pagination reactions are removed after page navigation', async () => {
  const removed: Array<{ channelId: string; messageId: string; emoji: string; userId: string }> = [];
  const edited: Array<{ channelId: string; messageId: string; payload: unknown }> = [];
  const router = createRouter({
    async removeUserReactionFromMessage(channelId: string, messageId: string, emoji: string, userId: string) {
      removed.push({ channelId, messageId, emoji, userId });
      return null;
    },
    async editMessage(channelId: string, messageId: string, payload: unknown) {
      edited.push({ channelId, messageId, payload });
      return null;
    },
  });

  try {
    router.helpPaginations.set('message-1', {
      channelId: 'channel-1',
      messageId: 'message-1',
      pages: [{ content: 'page-1' }, { content: 'page-2' }],
      index: 0,
      updatedAt: 0,
    });

    await router.handleReactionAdd({
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      message_id: 'message-1',
      user_id: 'user-1',
      emoji: { name: '➡️' },
    });
  } finally {
    cleanupRouter(router);
  }

  assert.deepEqual(removed, [{
    channelId: 'channel-1',
    messageId: 'message-1',
    emoji: '➡️',
    userId: 'user-1',
  }]);
  assert.equal(edited.length, 1);
});

test('search reaction picks also remove the user reaction', async () => {
  const removed: Array<{ channelId: string; messageId: string; emoji: string; userId: string }> = [];
  const router = createRouter({
    async removeUserReactionFromMessage(channelId: string, messageId: string, emoji: string, userId: string) {
      removed.push({ channelId, messageId, emoji, userId });
      return null;
    },
  });

  let picked: { pickedIndex: number; userId: string } | null = null;
  router._applySearchReactionSelection = async (_state, pickedIndex, userId) => {
    picked = { pickedIndex, userId };
  };

  try {
    router.searchReactionSelections.set('message-2', {
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-2',
      userId: 'user-1',
      tracks: [{ title: 'Track 1' }],
      expiresAt: Date.now() + 10_000,
    });

    await router.handleReactionAdd({
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      message_id: 'message-2',
      user_id: 'user-1',
      emoji: { name: '1️⃣' },
    });
  } finally {
    cleanupRouter(router);
  }

  assert.deepEqual(removed, [{
    channelId: 'channel-1',
    messageId: 'message-2',
    emoji: '1️⃣',
    userId: 'user-1',
  }]);
  assert.deepEqual(picked, { pickedIndex: 1, userId: 'user-1' });
});

test('ephemeral cleanup starts even when weekly recap services are unavailable', () => {
  const router = createRouter();

  try {
    assert.ok(router.ephemeralCleanupHandle);
    assert.equal(router.weeklySweepHandle, null);
  } finally {
    cleanupRouter(router);
  }
});
