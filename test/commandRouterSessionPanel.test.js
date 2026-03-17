import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.js';
function createRouter({ rest, library, sessions }) {
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
    logger: null,
    rest,
    gateway: null,
    sessions,
    guildConfigs: null,
    voiceStateStore: {
      countUsersInChannel() {
        return 1;
      },
    },
    lyrics: null,
    library,
    permissionService: null,
    botUserId: 'bot-1',
    startedAt: Date.now(),
  });
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
    },
    library: {
      async getGuildFeatureConfig() {
        return {
          sessionPanelChannelId: 'channel-1',
          sessionPanelMessageId: 'message-1',
        };
      },
      async patchGuildFeatureConfig() {},
    },
    sessions: {
      on() {},
      sessions: new Map(),
      getVoteCount() {
        return 0;
      },
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
    clearInterval(router.sessionPanelLiveHandle);
    clearInterval(router.weeklySweepHandle);
  }

  assert.equal(editCalls, 0);
  assert.equal(sendCalls, 0);
});
