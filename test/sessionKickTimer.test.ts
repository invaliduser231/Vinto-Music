import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';

function createManager(options: { rest?: Record<string, unknown> | null; voiceStateStore?: Record<string, unknown> | null } = {}) {
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
    rest: (options.rest ?? null) as never,
    logger: null,
    voiceStateStore: (options.voiceStateStore ?? null) as never,
    botUserId: 'bot-1',
  });
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'guild-1:voice-1',
    guildId: 'guild-1',
    targetVoiceChannelId: 'voice-1',
    connection: { channelId: 'voice-1', connected: true },
    player: {},
    settings: { djRoleIds: new Set<string>(), musicLogChannelId: null },
    textChannelId: 'text-1',
    ...overrides,
  };
}

test('scheduleKickTimer stores timer metadata and exposes remaining time', () => {
  const manager = createManager();
  const session = createSession();

  const result = manager.scheduleKickTimer(session as never, 60, { requestedBy: 'user-5' });
  assert.equal(result.durationSec, 60);

  const info = manager.getKickTimerInfo(session as never);
  assert.ok(info);
  assert.equal(info?.durationSec, 60);
  assert.equal(info?.requestedBy, 'user-5');
  assert.ok((info?.remainingSec ?? 0) > 0 && (info?.remainingSec ?? 0) <= 60);

  assert.equal(manager.cancelKickTimer(session as never), true);
  assert.equal(manager.getKickTimerInfo(session as never), null);
});

test('_executeKickTimer disconnects every human member except the bot', async () => {
  const disconnectCalls: Array<[string, string]> = [];
  const notifications: Array<[string, unknown]> = [];
  const manager = createManager({
    rest: {
      async disconnectMemberFromVoice(guildId: string, userId: string) {
        disconnectCalls.push([guildId, userId]);
        return { guildId, userId };
      },
      async sendMessage(channelId: string, payload: unknown) {
        notifications.push([channelId, payload]);
        return { channelId, payload };
      },
    },
    voiceStateStore: {
      getUsersInChannel() {
        return ['user-2', 'bot-1', 'user-3'];
      },
    },
  });
  const session = createSession();

  await manager._executeKickTimer(session as never);

  assert.deepEqual(disconnectCalls, [['guild-1', 'user-2'], ['guild-1', 'user-3']]);
  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0]?.[1] ?? ''), /disconnected \*\*2\*\* members/i);
  assert.equal(manager.getKickTimerInfo(session as never), null);
});

test('_executeKickTimer reports missing Move Members permission', async () => {
  const notifications: Array<[string, unknown]> = [];
  const manager = createManager({
    rest: {
      async disconnectMemberFromVoice() {
        const err = new Error('missing permissions to move members') as Error & { status?: number };
        err.status = 403;
        throw err;
      },
      async sendMessage(channelId: string, payload: unknown) {
        notifications.push([channelId, payload]);
        return { channelId, payload };
      },
    },
    voiceStateStore: {
      getUsersInChannel() {
        return ['user-2'];
      },
    },
  });
  const session = createSession();

  await manager._executeKickTimer(session as never);

  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0]?.[1] ?? ''), /Move Members/i);
});

test('destroy clears a pending kick timer', async () => {
  const manager = createManager({ rest: { async disconnectMemberFromVoice() {} } });
  const session = createSession();
  manager.sessions.set('guild-1:voice-1', session as never);

  manager.scheduleKickTimer(session as never, 120);
  assert.ok(manager.getKickTimerInfo(session as never));

  await manager.destroy('guild-1', 'manual_command', { sessionId: 'guild-1:voice-1' });
  assert.equal((session as { kickTimer?: unknown }).kickTimer ?? null, null);
});
