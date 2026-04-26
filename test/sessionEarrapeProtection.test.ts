import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';

function createManager(restOverride: Record<string, unknown> | null = null) {
  return new SessionManager({
    gateway: {
      joinVoice() {},
      leaveVoice() {},
      on() {},
      off() {},
    },
    config: {
      sessionIdleMs: 20_000,
      defaultDedupeEnabled: false,
      defaultStayInVoiceEnabled: false,
      defaultVolumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
    },
    rest: restOverride as never,
    logger: null,
    voiceStateStore: null,
    botUserId: 'bot-1',
  });
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'guild-1:voice-1',
    guildId: 'guild-1',
    targetVoiceChannelId: 'voice-1',
    connection: {
      channelId: 'voice-1',
      connected: true,
      setEarrapeProtectionEnabled() {},
      setBotUserId() {},
    },
    player: {
      volumePercent: 100,
      setVolumePercent() {},
      queue: { pendingSize: 0 },
    },
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      earrapeProtectionEnabled: false,
      minimalMode: false,
      volumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: new Set<string>(),
      musicLogChannelId: null,
    },
    votes: {
      trackId: null,
      voters: new Set<string>(),
    },
    snapshot: {
      dirty: false,
      lastPersistAt: 0,
      inFlight: false,
    },
    diagnostics: {
      timer: null,
      inFlight: false,
    },
    ...overrides,
  };
}

test('applyGuildConfig syncs earrape protection to active voice connections', () => {
  const manager = createManager();
  const syncCalls: boolean[] = [];
  const session = createSession({
    connection: {
      channelId: 'voice-1',
      connected: true,
      setEarrapeProtectionEnabled(enabled: unknown) {
        syncCalls.push(Boolean(enabled));
      },
      setBotUserId() {},
    },
  });

  manager.sessions.set('guild-1:voice-1', session as never);
  manager.applyGuildConfig('guild-1', {
    guildId: 'guild-1',
    prefix: '!',
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      earrapeProtectionEnabled: true,
      minimalMode: false,
      volumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: [],
      musicLogChannelId: null,
    },
  });

  assert.deepEqual(syncCalls, [true]);
  assert.equal(session.settings.earrapeProtectionEnabled, true);
});

test('setBotUserId propagates to existing connections', () => {
  const manager = createManager();
  const botUserCalls: Array<string | null> = [];
  const session = createSession({
    connection: {
      channelId: 'voice-1',
      connected: true,
      setEarrapeProtectionEnabled() {},
      setBotUserId(botUserId: unknown) {
        botUserCalls.push(String(botUserId ?? '').trim() || null);
      },
    },
  });

  manager.sessions.set('guild-1:voice-1', session as never);
  manager.setBotUserId('bot-9');
  assert.deepEqual(botUserCalls, ['bot-9']);
});

test('earrape detection callback disconnects offending participants when enabled', async () => {
  const disconnectCalls: Array<[string, string]> = [];
  const manager = createManager({
    async disconnectMemberFromVoice(guildId: string, userId: string) {
      disconnectCalls.push([guildId, userId]);
      return { guildId, userId };
    },
  });
  const session = createSession({
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      earrapeProtectionEnabled: true,
      minimalMode: false,
      volumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: new Set<string>(),
      musicLogChannelId: null,
    },
  });
  manager.sessions.set('guild-1:voice-1', session as never);

  await manager._handleEarrapeDetected({
    guildId: 'guild-1',
    channelId: 'voice-1',
    participantId: 'user-77',
    peak: 0.91,
    threshold: 0.38,
  });

  assert.deepEqual(disconnectCalls, [['guild-1', 'user-77']]);
});

test('earrape detection notifies channel when disconnect fails due to missing permissions', async () => {
  const notifications: Array<[string, unknown]> = [];
  const manager = createManager({
    async disconnectMemberFromVoice() {
      const err = new Error('missing permissions to move members') as Error & { status?: number };
      err.status = 403;
      throw err;
    },
    async sendMessage(channelId: string, payload: unknown) {
      notifications.push([channelId, payload]);
      return { channelId, payload };
    },
  });
  const session = createSession({
    textChannelId: 'text-7',
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
      earrapeProtectionEnabled: true,
      minimalMode: false,
      volumePercent: 100,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      djRoleIds: new Set<string>(),
      musicLogChannelId: null,
    },
  });
  manager.sessions.set('guild-1:voice-1', session as never);

  await manager._handleEarrapeDetected({
    guildId: 'guild-1',
    channelId: 'voice-1',
    participantId: 'user-88',
    peak: 0.92,
    threshold: 0.38,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.[0], 'text-7');
  assert.match(String(notifications[0]?.[1] ?? ''), /Move Members/i);
});
