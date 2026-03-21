import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

type RouterDeps = {
  rest: unknown;
  library: unknown;
  sessions: unknown;
};

function createRouter({ rest, library, sessions }: RouterDeps) {
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
    rest: rest as ConstructorParameters<typeof CommandRouter>[0]['rest'],
    gateway: {
      on() {},
      off() {},
    },
    sessions: sessions as ConstructorParameters<typeof CommandRouter>[0]['sessions'],
    guildConfigs: null,
    voiceStateStore: {
      countUsersInChannel() {
        return 1;
      },
    },
    lyrics: null,
    library: (library ?? null) as ConstructorParameters<typeof CommandRouter>[0]['library'],
    permissionService: null,
    botUserId: 'bot-1',
    startedAt: Date.now(),
  } as ConstructorParameters<typeof CommandRouter>[0]);
}

test('session panel update is disabled and performs no REST work', async () => {
  let sendCalls = 0;
  let editCalls = 0;

  const router = createRouter({
    rest: {
      async editMessage() {
        editCalls += 1;
      },
      async sendMessage() {
        sendCalls += 1;
        return { id: 'new-message' };
      },
      async sendTyping() {},
    },
    library: {
      async getGuildFeatureConfig() {
        return {
          webhookUrl: null,
          recapChannelId: null,
          queueGuard: null,
          sessionPanelChannelId: 'channel-1',
          sessionPanelMessageId: 'message-1',
        };
      },
      async patchGuildFeatureConfig() {},
    },
    sessions: {
      on() {},
      sessions: new Map(),
    },
  });

  try {
    const result = await router._sendSessionPanelUpdate({
      guildId: 'guild-1',
      textChannelId: 'channel-1',
      settings: {},
      connection: { channelId: 'voice-1' },
      player: {
        currentTrack: {
          title: 'Demo Track',
          duration: '3:00',
          requestedBy: 'user-1',
          thumbnailUrl: null,
          isLive: false,
        },
        pendingTracks: [],
        getProgressSeconds() {
          return 10;
        },
      },
    }, 'live');
    assert.equal(result, null);
  } finally {
    if (router.sessionPanelLiveHandle) clearInterval(router.sessionPanelLiveHandle);
    if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
  }

  assert.equal(editCalls, 0);
  assert.equal(sendCalls, 0);
});





