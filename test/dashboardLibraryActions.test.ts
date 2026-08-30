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

function waitForMessage(
  ws: WebSocket,
  match: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 3000);
    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data ?? '')) as Record<string, unknown>;
        if (!match(payload)) return;
        clearTimeout(timer);
        resolve(payload);
      } catch {
        // ignore malformed frames
      }
    });
  });
}

async function openSubscribedSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket failed')));
  });
  ws.send(JSON.stringify({ op: 'auth', secret: 'local-secret' }));
  await waitForMessage(ws, (payload) => payload.op === 'auth_ok');
  ws.send(JSON.stringify({
    op: 'subscribe',
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    userId: 'user-1',
    roleIds: [],
  }));
  await waitForMessage(ws, (payload) => payload.op === 'session');
  return ws;
}

test('DashboardServer handles favorite and library management actions', async () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>() },
    player: {
      playing: true,
      paused: false,
      loopMode: 'off',
      volumePercent: 100,
      currentTrack: { title: 'Live', url: 'https://example.com/live', artist: 'Artist' },
      pendingTracks: [],
      getProgressSeconds: () => 3,
    },
  } as unknown as Session;

  const calls: Array<{ method: string; args: unknown[] }> = [];
  const library = {
    renameUserFavorite: async (...args: unknown[]) => {
      calls.push({ method: 'renameUserFavorite', args });
      return { alias: args[2] };
    },
    removeUserFavorite: async (...args: unknown[]) => {
      calls.push({ method: 'removeUserFavorite', args });
      return { title: 'removed' };
    },
    createGuildPlaylist: async (...args: unknown[]) => {
      calls.push({ method: 'createGuildPlaylist', args });
      return { name: args[1], tracks: [] };
    },
    deleteGuildPlaylist: async (...args: unknown[]) => {
      calls.push({ method: 'deleteGuildPlaylist', args });
      return true;
    },
    addTracksToGuildPlaylist: async (...args: unknown[]) => {
      calls.push({ method: 'addTracksToGuildPlaylist', args });
      return { added: 1 };
    },
    deleteQueueTemplate: async (...args: unknown[]) => {
      calls.push({ method: 'deleteQueueTemplate', args });
      return true;
    },
    setGuildStation: async (...args: unknown[]) => {
      calls.push({ method: 'setGuildStation', args });
      return { key: 'lofi' };
    },
    deleteGuildStation: async (...args: unknown[]) => {
      calls.push({ method: 'deleteGuildStation', args });
      return true;
    },
  };

  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19102,
    secret: 'local-secret',
    sessions: createMockSessions(session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    library: library as unknown as import('../src/bot/services/musicLibraryStore.ts').MusicLibraryStore,
  });

  await server.start();

  try {
    const ws = await openSubscribedSocket(19102);

    ws.send(JSON.stringify({ op: 'action', action: 'favoriteRename', index: 2, alias: 'banger', requestId: 'r1' }));
    const rename = await waitForMessage(ws, (payload) => payload.requestId === 'r1');
    assert.equal(rename.op, 'action_result');
    assert.equal(rename.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'renameUserFavorite', args: ['user-1', 2, 'banger'] });

    ws.send(JSON.stringify({ op: 'action', action: 'favoriteRemove', index: 3, requestId: 'r2' }));
    const remove = await waitForMessage(ws, (payload) => payload.requestId === 'r2');
    assert.equal(remove.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'removeUserFavorite', args: ['user-1', 3] });

    ws.send(JSON.stringify({ op: 'action', action: 'playlistCreate', name: 'Late Night', requestId: 'r3' }));
    const create = await waitForMessage(ws, (payload) => payload.requestId === 'r3');
    assert.equal(create.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'createGuildPlaylist', args: ['guild-1', 'Late Night', 'user-1'] });

    ws.send(JSON.stringify({ op: 'action', action: 'playlistAddCurrent', name: 'Late Night', requestId: 'r4' }));
    const addCurrent = await waitForMessage(ws, (payload) => payload.requestId === 'r4');
    assert.equal(addCurrent.ok, true);
    const addCall = calls.at(-1)!;
    assert.equal(addCall.method, 'addTracksToGuildPlaylist');
    assert.equal((addCall.args[2] as Array<{ title?: string }>)[0]?.title, 'Live');

    ws.send(JSON.stringify({ op: 'action', action: 'templateDelete', key: 'party-mix', requestId: 'r5' }));
    const template = await waitForMessage(ws, (payload) => payload.requestId === 'r5');
    assert.equal(template.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'deleteQueueTemplate', args: ['guild-1', 'party-mix'] });

    ws.send(JSON.stringify({ op: 'action', action: 'playlistDelete', name: 'Late Night', requestId: 'r6' }));
    const del = await waitForMessage(ws, (payload) => payload.requestId === 'r6');
    assert.equal(del.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'deleteGuildPlaylist', args: ['guild-1', 'Late Night'] });

    ws.send(JSON.stringify({ op: 'action', action: 'stationCreate', name: 'Lofi', url: 'https://stream.example.com/lofi', requestId: 'r7' }));
    const station = await waitForMessage(ws, (payload) => payload.requestId === 'r7');
    assert.equal(station.ok, true);
    const stationCall = calls.at(-1)!;
    assert.equal(stationCall.method, 'setGuildStation');
    assert.equal(stationCall.args[1], 'Lofi');
    assert.deepEqual(stationCall.args[2], { url: 'https://stream.example.com/lofi' });

    ws.send(JSON.stringify({ op: 'action', action: 'stationCreate', name: 'Bad', url: 'javascript:alert(1)', requestId: 'r8' }));
    const rejectedStation = await waitForMessage(ws, (payload) => payload.requestId === 'r8' || payload.op === 'error');
    assert.equal(rejectedStation.op, 'error');
    assert.equal(calls.at(-1)!.method, 'setGuildStation');

    ws.send(JSON.stringify({ op: 'action', action: 'stationDelete', key: 'lofi', requestId: 'r9' }));
    const stationDeleted = await waitForMessage(ws, (payload) => payload.requestId === 'r9');
    assert.equal(stationDeleted.ok, true);
    assert.deepEqual(calls.at(-1), { method: 'deleteGuildStation', args: ['guild-1', 'lofi'] });

    ws.close();
  } finally {
    await server.stop();
  }
});

test('DashboardServer rejects playlist management without control access', async () => {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([
    ['user-1', 'vc-1'],
  ]));

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>(['dj-role']) },
    player: {
      playing: true,
      paused: false,
      loopMode: 'off',
      volumePercent: 100,
      currentTrack: { title: 'Live' },
      pendingTracks: [],
      getProgressSeconds: () => 3,
    },
  } as unknown as Session;

  const calls: string[] = [];
  const library = {
    createGuildPlaylist: async () => {
      calls.push('createGuildPlaylist');
      return {};
    },
    renameUserFavorite: async () => {
      calls.push('renameUserFavorite');
      return {};
    },
  };

  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19103,
    secret: 'local-secret',
    sessions: createMockSessions(session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
    library: library as unknown as import('../src/bot/services/musicLibraryStore.ts').MusicLibraryStore,
  });

  await server.start();

  try {
    const ws = await openSubscribedSocket(19103);

    ws.send(JSON.stringify({ op: 'action', action: 'playlistCreate', name: 'Blocked', requestId: 'p1' }));
    const rejected = await waitForMessage(ws, (payload) => payload.requestId === 'p1');
    assert.equal(rejected.op, 'error');
    assert.equal(rejected.message, 'control not allowed');
    assert.equal(calls.includes('createGuildPlaylist'), false);

    ws.send(JSON.stringify({ op: 'action', action: 'favoriteRename', index: 1, alias: 'mine', requestId: 'p2' }));
    const allowed = await waitForMessage(ws, (payload) => payload.requestId === 'p2');
    assert.equal(allowed.op, 'action_result');
    assert.equal(calls.includes('renameUserFavorite'), true);

    ws.close();
  } finally {
    await server.stop();
  }
});
