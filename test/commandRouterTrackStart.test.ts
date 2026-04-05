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

test('trackStart popup includes the active voice channel mention', async () => {
  const sessions = new EventEmitter();
  const router = createRouter(sessions);
  const calls: Array<{ channelId: string; type: string; text: string }> = [];

  router._safeReply = (async (channelId: string, type: string, text: string) => {
    calls.push({ channelId, type, text });
    return null;
  }) as CommandRouter['_safeReply'];

  try {
    sessions.emit('trackStart', {
      session: {
        textChannelId: 'text-1',
        connection: { channelId: 'voice-1' },
        settings: {},
      },
      track: {
        title: 'Demo Track',
        duration: '3:00',
        source: 'youtube',
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (router.sessionPanelLiveHandle) clearInterval(router.sessionPanelLiveHandle);
    if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
    if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
  }

  assert.deepEqual(calls, [{
    channelId: 'text-1',
    type: 'info',
    text: 'Now playing in <#voice-1>: **Demo Track** (3:00)',
  }]);
});

test('trackStart popup waits briefly for deferred metadata before sending', async () => {
  const sessions = new EventEmitter();
  const router = createRouter(sessions);
  const calls: Array<{ channelId: string; type: string; text: string }> = [];
  const track = {
    title: 'YouTube Track',
    duration: 'Unknown',
    source: 'youtube',
    metadataDeferred: true,
  };

  router._safeReply = (async (channelId: string, type: string, text: string) => {
    calls.push({ channelId, type, text });
    return null;
  }) as CommandRouter['_safeReply'];

  try {
    sessions.emit('trackStart', {
      session: {
        textChannelId: 'text-1',
        connection: { channelId: 'voice-1' },
        settings: {},
      },
      track,
    });

    setTimeout(() => {
      track.title = 'Hydrated Track';
      track.duration = '3:33';
      track.metadataDeferred = false;
    }, 10);

    await new Promise((resolve) => setTimeout(resolve, 1250));
  } finally {
    if (router.sessionPanelLiveHandle) clearInterval(router.sessionPanelLiveHandle);
    if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
    if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
  }

  assert.deepEqual(calls, [{
    channelId: 'text-1',
    type: 'info',
    text: 'Now playing in <#voice-1>: **Hydrated Track** (3:33)',
  }]);
});

test('trackStart popup is suppressed for persistent session restore playback', async () => {
  const sessions = new EventEmitter();
  const router = createRouter(sessions);
  const calls: Array<{ channelId: string; type: string; text: string }> = [];

  router._safeReply = (async (channelId: string, type: string, text: string) => {
    calls.push({ channelId, type, text });
    return null;
  }) as CommandRouter['_safeReply'];

  try {
    sessions.emit('trackStart', {
      session: {
        textChannelId: 'text-1',
        connection: { channelId: 'voice-1' },
        settings: {},
      },
      track: {
        title: 'Restored Track',
        duration: '3:00',
        source: 'youtube',
      },
      restoredFromPersistentSession: true,
    });

    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (router.sessionPanelLiveHandle) clearInterval(router.sessionPanelLiveHandle);
    if (router.weeklySweepHandle) clearInterval(router.weeklySweepHandle);
    if (router.ephemeralCleanupHandle) clearInterval(router.ephemeralCleanupHandle);
  }

  assert.deepEqual(calls, []);
});
