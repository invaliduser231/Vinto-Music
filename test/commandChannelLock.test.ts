import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

function createRouter(commandChannelIds: string[]) {
  const sent: Array<{ channelId: string; content: unknown }> = [];
  const deleted: Array<{ channelId: string; messageId: string }> = [];
  const router = new CommandRouter({
    config: {
      prefix: '!',
      enableEmbeds: true,
      commandRateLimitEnabled: false,
      sessionIdleMs: 300_000,
    },
    rest: {
      async sendTyping() {},
      async editMessage() {},
      async sendMessage(channelId: string, payload: { content?: unknown }) {
        sent.push({ channelId, content: payload?.content });
        return { id: `notice-${sent.length}` };
      },
      async deleteMessage(channelId: string, messageId: string) {
        deleted.push({ channelId, messageId });
      },
    },
    gateway: { on() {}, off() {} },
    sessions: {
      on() {},
      sessions: new Map(),
      has() { return false; },
      bindTextChannel() { return null; },
      get() { return null; },
      destroy() { return Promise.resolve(null); },
    },
    guildConfigs: {
      async get() {
        return { prefix: '!', settings: { commandChannelIds } };
      },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() { return null; },
      countUsersInChannel() { return 1; },
    },
    lyrics: null,
    library: null,
    permissionService: null,
    botUserId: 'bot-1',
    startedAt: Date.now(),
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);
  return { router, sent, deleted };
}

function cleanup(router: CommandRouter) {
  if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
  if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
}

test('commands outside the music channels are removed and redirected once', async () => {
  const { router, sent, deleted } = createRouter(['1000001']);
  try {
    for (const id of ['m1', 'm2']) {
      await router.handleMessage({
        id,
        content: '!ping',
        channel_id: '2000002',
        guild_id: '3000003',
        author: { id: '4000004', bot: false },
      });
    }

    assert.deepEqual(deleted.filter((entry) => entry.messageId.startsWith('m')), [
      { channelId: '2000002', messageId: 'm1' },
      { channelId: '2000002', messageId: 'm2' },
    ]);
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]!.content), /<#1000001>/);
  } finally {
    cleanup(router);
  }
});

test('commands inside a music channel and exempt commands still run', async () => {
  const { router, sent, deleted } = createRouter(['1000001']);
  try {
    await router.handleMessage({
      id: 'm1',
      content: '!ping',
      channel_id: '1000001',
      guild_id: '3000003',
      author: { id: '4000004', bot: false },
    });
    await router.handleMessage({
      id: 'm2',
      content: '!musicchannel',
      channel_id: '2000002',
      guild_id: '3000003',
      author: { id: '4000004', bot: false },
    });

    assert.deepEqual(deleted, []);
    assert.equal(sent.some((entry) => entry.channelId === '1000001'), true);
  } finally {
    cleanup(router);
  }
});

test('no lock is applied when no music channel is configured', async () => {
  const { router, deleted } = createRouter([]);
  try {
    await router.handleMessage({
      id: 'm1',
      content: '!ping',
      channel_id: '2000002',
      guild_id: '3000003',
      author: { id: '4000004', bot: false },
    });
    assert.deepEqual(deleted, []);
  } finally {
    cleanup(router);
  }
});
