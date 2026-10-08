import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import type { Session } from '../src/types/domain.ts';
import type { SessionManager } from '../src/bot/sessionManager.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';
import type { GuildConfigStore } from '../src/bot/services/guildConfigStore.ts';
import type { GuildStateCache } from '../src/bot/services/guildStateCache.ts';
import type { MusicLibraryStore } from '../src/bot/services/musicLibraryStore.ts';

type MockSessions = EventEmitter & {
  listByGuild: (guildId: string) => Session[];
  get: (guildId: string, voiceChannelId: string) => Session | null;
};

const MEMBERS: Record<string, string[]> = {
  '100000000000000001': ['dj-role'],
  '100000000000000002': [],
  '100000000000000003': [],
};

function createMockSessions(session: Session): MockSessions {
  const emitter = new EventEmitter() as MockSessions;
  emitter.listByGuild = (guildId: string) => (String(session.guildId) === String(guildId) ? [session] : []);
  emitter.get = (guildId: string, voiceChannelId: string) => (
    String(session.guildId) === String(guildId) && voiceChannelId === 'vc-1' ? session : null
  );
  return emitter;
}

function createServer(port: number) {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['100000000000000001', 'vc-1'],
  ]));

  const pauseCalls: number[] = [];
  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set(['dj-role']) },
    player: {
      currentTrack: null,
      pendingTracks: [],
      playing: true,
      paused: false,
      loopMode: 'off',
      volumePercent: 100,
      getProgressSeconds: () => 0,
      pause: () => {
        pauseCalls.push(Date.now());
        return true;
      },
    },
  } as unknown as Session;

  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port,
    secret: 'local-secret',
    requireTicket: true,
    sessions: createMockSessions(session) as unknown as SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    resolveMemberRoleIds: async (_guildId, userId) => MEMBERS[userId] ?? [],
    getGuildMember: async (_guildId, userId) => {
      if (!(userId in MEMBERS)) throw new Error('Unknown Member');
      return { user: { id: userId, username: userId } };
    },
    guildStateCache: {
      resolveOwnerId: () => '100000000000000003',
      computeManageGuildPermission: () => false,
    } as unknown as GuildStateCache,
    guildConfigs: {
      get: async () => ({ guildId: 'guild-1', prefix: '!', settings: { djRoleIds: ['dj-role'] } }),
    } as unknown as GuildConfigStore,
    library: {
      getGuildFeatureConfig: async () => ({ webhookUrl: 'https://fluxer.example/api/webhooks/1/secret-token' }),
    } as unknown as MusicLibraryStore,
  });

  return { server, pauseCalls };
}

test('session actions use the proxied user id and ignore a user id in the body', async () => {
  const { server, pauseCalls } = createServer(19111);
  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19111/api/v1/session/action', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'X-User-Id': '100000000000000002',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        guildId: 'guild-1',
        voiceChannelId: 'vc-1',
        action: 'pause',
        userId: '100000000000000001',
        roleIds: ['dj-role'],
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(pauseCalls.length, 0);
  } finally {
    await server.stop();
  }
});

test('session actions still work for a DJ identified by the proxy', async () => {
  const { server, pauseCalls } = createServer(19112);
  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19112/api/v1/session/action', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'X-User-Id': '100000000000000001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ guildId: 'guild-1', voiceChannelId: 'vc-1', action: 'pause' }),
    });

    assert.equal(response.status, 200);
    assert.equal(pauseCalls.length, 1);
  } finally {
    await server.stop();
  }
});

test('guild settings are denied to users outside the guild', async () => {
  const { server } = createServer(19113);
  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19113/api/v1/guild/settings?guildId=guild-1', {
      headers: { Authorization: 'Bearer local-secret', 'X-User-Id': '100000000000000009' },
    });

    assert.equal(response.status, 403);
    const payload = await response.json() as { settings?: unknown };
    assert.equal(payload.settings, undefined);
  } finally {
    await server.stop();
  }
});

test('guild settings hide the webhook url from members who cannot manage the guild', async () => {
  const { server } = createServer(19114);
  await server.start();

  try {
    const memberResponse = await fetch('http://127.0.0.1:19114/api/v1/guild/settings?guildId=guild-1', {
      headers: { Authorization: 'Bearer local-secret', 'X-User-Id': '100000000000000002' },
    });
    const memberPayload = await memberResponse.json() as { settings?: { canManage?: boolean; webhookUrl?: string | null } };
    assert.equal(memberResponse.status, 200);
    assert.equal(memberPayload.settings?.canManage, false);
    assert.equal(memberPayload.settings?.webhookUrl, null);

    const ownerResponse = await fetch('http://127.0.0.1:19114/api/v1/guild/settings?guildId=guild-1', {
      headers: { Authorization: 'Bearer local-secret', 'X-User-Id': '100000000000000003' },
    });
    const ownerPayload = await ownerResponse.json() as { settings?: { canManage?: boolean; webhookUrl?: string | null } };
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerPayload.settings?.canManage, true);
    assert.equal(ownerPayload.settings?.webhookUrl, 'https://fluxer.example/api/webhooks/1/secret-token');
  } finally {
    await server.stop();
  }
});
