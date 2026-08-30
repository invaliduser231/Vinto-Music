import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import type { Session } from '../src/types/domain.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

type MockSessions = EventEmitter & {
  listByGuild: (guildId: string) => Session[];
  get: (guildId: string, voiceChannelId: string) => Session | null;
};

function createMockSessions(session: Session): MockSessions {
  const emitter = new EventEmitter() as MockSessions;
  emitter.listByGuild = (guildId: string) => (
    String(session.guildId) === String(guildId) ? [session] : []
  );
  emitter.get = (guildId: string, voiceChannelId: string) => {
    if (String(session.guildId) !== String(guildId)) return null;
    const channelId = String(session.connection?.channelId ?? session.targetVoiceChannelId ?? '');
    return channelId === String(voiceChannelId) ? session : null;
  };
  return emitter;
}

test('DashboardServer resolves member roles server-side when configured', async () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set(['dj-role']) },
    player: {
      currentTrack: null,
      pendingTracks: [],
      playing: false,
      paused: false,
      loopMode: 'off',
      volumePercent: 100,
      getProgressSeconds: () => 0,
    },
  } as Session;

  const sessions = createMockSessions(session);
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19094,
    secret: 'local-secret',
    sessions: sessions as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    resolveMemberRoleIds: async (guildId, userId) => {
      assert.equal(guildId, 'guild-1');
      assert.equal(userId, 'user-1');
      return ['dj-role'];
    },
  });

  await server.start();

  try {
    const allowed = await fetch(
      'http://127.0.0.1:19094/api/v1/session?guildId=guild-1&voiceChannelId=vc-1',
      {
        headers: {
          Authorization: 'Bearer local-secret',
          'X-User-Id': 'user-1',
          'X-User-Role-Ids': 'wrong-role',
        },
      },
    );
    const allowedPayload = await allowed.json() as { session?: { canControl?: boolean } };
    assert.equal(allowed.status, 200);
    assert.equal(allowedPayload.session?.canControl, true);

    const denied = await fetch(
      'http://127.0.0.1:19094/api/v1/session?guildId=guild-1&voiceChannelId=vc-1',
      {
        headers: {
          Authorization: 'Bearer local-secret',
          'X-User-Id': 'user-2',
          'X-User-Role-Ids': 'dj-role',
        },
      },
    );
    const deniedPayload = await denied.json() as { session?: { canControl?: boolean } };
    assert.equal(denied.status, 200);
    assert.equal(deniedPayload.session?.canControl, false);
  } finally {
    await server.stop();
  }
});
