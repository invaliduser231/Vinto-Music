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

test('DashboardServer websocket subscribe rejects users outside voice channel', async () => {
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

  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19096,
    secret: 'local-secret',
    sessions: createMockSessions(session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
  });

  await server.start();

  try {
    const ws = new WebSocket('ws://127.0.0.1:19096');
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket failed')));
    });

    ws.send(JSON.stringify({ op: 'auth', secret: 'local-secret' }));
    await waitForMessage(ws, (payload) => payload.op === 'auth_ok');

    ws.send(JSON.stringify({
      op: 'subscribe',
      guildId: 'guild-1',
      voiceChannelId: 'vc-2',
      userId: 'user-1',
      roleIds: [],
    }));

    const error = await waitForMessage(ws, (payload) => payload.op === 'error');
    assert.equal(error.message, 'not_in_voice');
    ws.close();
  } finally {
    await server.stop();
  }
});

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
