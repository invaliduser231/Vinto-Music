import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import {
  MAX_TICKET_LIFETIME_MS,
  signDashboardTicket,
  verifyDashboardTicket,
} from '../src/dashboard/ticket.ts';
import type { Session } from '../src/types/domain.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

const SECRET = 'ticket-secret-for-tests';

test('a freshly signed ticket verifies and carries the user id', () => {
  const exp = Date.now() + 30_000;
  const ticket = signDashboardTicket({ userId: 'user-1', exp }, SECRET);
  const verified = verifyDashboardTicket(ticket, SECRET);
  assert.deepEqual(verified, { userId: 'user-1', exp });
});

test('a ticket signed with another secret is rejected', () => {
  const ticket = signDashboardTicket({ userId: 'user-1', exp: Date.now() + 30_000 }, 'other-secret');
  assert.equal(verifyDashboardTicket(ticket, SECRET), null);
});

test('tampering with the payload invalidates the signature', () => {
  const ticket = signDashboardTicket({ userId: 'user-1', exp: Date.now() + 30_000 }, SECRET);
  const forgedBody = Buffer
    .from(JSON.stringify({ userId: 'user-2', exp: Date.now() + 30_000 }), 'utf8')
    .toString('base64url');
  const signature = ticket.slice(ticket.lastIndexOf('.') + 1);
  assert.equal(verifyDashboardTicket(`${forgedBody}.${signature}`, SECRET), null);
});

test('an expired ticket is rejected', () => {
  const ticket = signDashboardTicket({ userId: 'user-1', exp: Date.now() - 1 }, SECRET);
  assert.equal(verifyDashboardTicket(ticket, SECRET), null);
});

test('a ticket that outlives the allowed window is rejected', () => {
  const exp = Date.now() + MAX_TICKET_LIFETIME_MS + 10_000;
  const ticket = signDashboardTicket({ userId: 'user-1', exp }, SECRET);
  assert.equal(verifyDashboardTicket(ticket, SECRET), null);
});

test('malformed input never throws', () => {
  for (const value of ['', '.', 'nodot', 'a.b', '....', 'x'.repeat(200)]) {
    assert.equal(verifyDashboardTicket(value, SECRET), null);
  }
});

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

function createServer(port: number) {
  const voiceStateStore = new VoiceStateStore();
  voiceStateStore.guildVoiceStates.set('guild-1', new Map([['user-1', 'vc-1']]));

  const session = {
    guildId: 'guild-1',
    connection: { channelId: 'vc-1' },
    targetVoiceChannelId: 'vc-1',
    settings: { djRoleIds: new Set<string>() },
    player: { playing: true, currentTrack: { title: 'Live' } },
  } as Session;

  return new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port,
    secret: SECRET,
    requireTicket: true,
    sessions: createMockSessions(session) as unknown as import('../src/bot/sessionManager.ts').SessionManager,
    voiceStateStore,
    botUserId: 'bot-1',
  });
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
        return;
      }
    });
  });
}

async function openSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket failed')));
  });
  return ws;
}

test('the raw secret no longer authenticates once tickets are required', async () => {
  const server = createServer(19101);
  await server.start();
  try {
    const ws = await openSocket(19101);
    ws.send(JSON.stringify({ op: 'auth', secret: SECRET }));
    const reply = await waitForMessage(ws, (payload) => (
      payload.op === 'auth_ok' || payload.op === 'auth_fail'
    ));
    assert.equal(reply.op, 'auth_fail');
    ws.close();
  } finally {
    await server.stop();
  }
});

test('a subscribe cannot claim a user id other than the one inside the ticket', async () => {
  const server = createServer(19102);
  await server.start();
  try {
    const ws = await openSocket(19102);
    const ticket = signDashboardTicket({ userId: 'user-2', exp: Date.now() + 30_000 }, SECRET);
    ws.send(JSON.stringify({ op: 'auth', ticket }));
    await waitForMessage(ws, (payload) => payload.op === 'auth_ok');

    ws.send(JSON.stringify({
      op: 'subscribe',
      guildId: 'guild-1',
      voiceChannelId: 'vc-1',
      userId: 'user-1',
      roleIds: ['dj-role'],
    }));

    const error = await waitForMessage(ws, (payload) => payload.op === 'error');
    assert.equal(error.message, 'not_in_voice');
    ws.close();
  } finally {
    await server.stop();
  }
});

test('a ticket for a listening user subscribes successfully', async () => {
  const server = createServer(19103);
  await server.start();
  try {
    const ws = await openSocket(19103);
    const ticket = signDashboardTicket({ userId: 'user-1', exp: Date.now() + 30_000 }, SECRET);
    ws.send(JSON.stringify({ op: 'auth', ticket }));
    await waitForMessage(ws, (payload) => payload.op === 'auth_ok');

    ws.send(JSON.stringify({
      op: 'subscribe',
      guildId: 'guild-1',
      voiceChannelId: 'vc-1',
    }));

    const message = await waitForMessage(ws, (payload) => payload.op === 'session');
    assert.ok(message.data);
    ws.close();
  } finally {
    await server.stop();
  }
});
