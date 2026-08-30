import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import type { Session, Track } from '../src/types/domain.ts';
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

test('DashboardServer returns guild overview over HTTP', async () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>() },
    player: { playing: true, currentTrack: { title: 'Live' } },
  } as Session;

  const sessions = createMockSessions(session);
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19095,
    secret: 'local-secret',
    sessions: sessions as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
  });

  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19095/api/v1/guild?guildId=guild-1', {
      headers: {
        Authorization: 'Bearer local-secret',
        'X-User-Id': 'user-1',
      },
    });
    const payload = await response.json() as {
      guild?: { userVoiceChannelId?: string; voiceChannels?: Array<{ id: string }> };
    };

    assert.equal(response.status, 200);
  assert.equal(payload.guild?.userVoiceChannelId, 'vc-1');
  assert.equal(payload.guild?.voiceChannels?.length, 1);
  assert.equal(payload.guild?.voiceChannels?.[0]?.id, 'vc-1');
  } finally {
    await server.stop();
  }
});

test('DashboardServer returns session snapshot over HTTP', async () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const track: Track = {
    title: 'Live track',
    url: 'https://example.com/live',
    duration: '4:00',
    source: 'deezer',
    artist: 'Artist',
  };

  const player = {
    currentTrack: track,
    pendingTracks: [],
    playing: true,
    paused: false,
    loopMode: 'off',
    volumePercent: 100,
    getProgressSeconds: () => 12,
    pause: () => true,
    resume: () => true,
    skip: () => true,
    setVolumePercent: (value: number) => value,
    removeFromQueue: () => null,
  };

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>() },
    player,
  } as Session;

  const sessions = createMockSessions(session);
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19093,
    secret: 'local-secret',
    sessions: sessions as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
  });

  await server.start();

  try {
    const response = await fetch(
      'http://127.0.0.1:19093/api/v1/session?guildId=guild-1&voiceChannelId=vc-1',
      {
        headers: {
          Authorization: 'Bearer local-secret',
          'X-User-Id': 'user-1',
        },
      },
    );
    const payload = await response.json() as { session?: { nowPlaying?: { title?: string } } };

    assert.equal(response.status, 200);
    assert.equal(payload.session?.nowPlaying?.title, 'Live track');
  } finally {
    await server.stop();
  }
});

test('DashboardServer filters bot guild ids from requested oauth guild list', async () => {
  const voiceStateStore = new VoiceStateStore();
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19098,
    secret: 'local-secret',
    sessions: createMockSessions({
      guildId: 'guild-1',
      connection: { channelId: 'vc-1' },
      targetVoiceChannelId: 'vc-1',
      settings: { djRoleIds: new Set<string>() },
      player: { playing: false },
    } as Session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    isBotInGuild: async (guildId) => guildId === 'guild-1' || guildId === 'guild-3',
  });

  await server.start();

  try {
    const response = await fetch(
      'http://127.0.0.1:19098/api/v1/bot/guilds?guildIds=guild-1,guild-2,guild-3',
      { headers: { Authorization: 'Bearer local-secret' } },
    );
    const payload = await response.json() as { guildIds?: string[] };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.guildIds, ['guild-1', 'guild-3']);
  } finally {
    await server.stop();
  }
});

test('DashboardServer returns bot guild ids over HTTP', async () => {
  const voiceStateStore = new VoiceStateStore();
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19097,
    secret: 'local-secret',
    sessions: createMockSessions({
      guildId: 'guild-1',
      connection: { channelId: 'vc-1' },
      targetVoiceChannelId: 'vc-1',
      settings: { djRoleIds: new Set<string>() },
      player: { playing: false },
    } as Session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    listBotGuildIds: async () => ['guild-1', 'guild-2'],
  });

  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19097/api/v1/bot/guilds', {
      headers: { Authorization: 'Bearer local-secret' },
    });
    const payload = await response.json() as { guildIds?: string[] };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.guildIds, ['guild-1', 'guild-2']);
  } finally {
    await server.stop();
  }
});
