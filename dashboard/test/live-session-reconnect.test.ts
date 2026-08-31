import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_DASHBOARD_WS_URL = 'ws://test.local/ws';

type Listener = (event: unknown) => void;

class MockSocket {
  static instances: MockSocket[] = [];
  static reset() {
    MockSocket.instances = [];
  }

  url: string;
  closed = false;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function installMocks(ticketDelayMs: number) {
  let released: Array<() => void> = [];

  (globalThis as { WebSocket?: unknown }).WebSocket = MockSocket as unknown;
  (globalThis as { fetch?: unknown }).fetch = (() => new Promise((resolve) => {
    const finish = () => resolve({
      ok: true,
      json: async () => ({ ticket: 'signed-ticket', userId: 'user-1' }),
    });
    if (ticketDelayMs <= 0) finish();
    else released.push(finish);
  })) as unknown;

  return {
    releaseTickets() {
      const pending = released;
      released = [];
      for (const finish of pending) finish();
    },
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

test('a reconnect during the ticket fetch leaves only one socket', async () => {
  MockSocket.reset();
  const mocks = installMocks(10);
  const { LiveSessionClient } = await import('../src/lib/live-session');

  const client = new LiveSessionClient({
    settings: { guildId: 'g1', voiceChannelId: 'vc1', userId: 'u1', roleIds: '' },
    onSession: () => {},
    onStatus: () => {},
  });

  client.connect();
  client.reconnect();
  mocks.releaseTickets();
  await flush();

  const live = MockSocket.instances.filter((socket) => !socket.closed);
  assert.equal(
    live.length,
    1,
    `expected exactly one live socket, got ${live.length} of ${MockSocket.instances.length}`,
  );

  client.disconnect();
});

test('a socket opening after disconnect closes itself', async () => {
  MockSocket.reset();
  const mocks = installMocks(10);
  const { LiveSessionClient } = await import('../src/lib/live-session');

  const client = new LiveSessionClient({
    settings: { guildId: 'g1', voiceChannelId: 'vc1', userId: 'u1', roleIds: '' },
    onSession: () => {},
    onStatus: () => {},
  });

  client.connect();
  client.disconnect();
  mocks.releaseTickets();
  await flush();

  const live = MockSocket.instances.filter((socket) => !socket.closed);
  assert.equal(live.length, 0, `no socket may survive a disconnect, got ${live.length}`);
});

test('an established socket subscribes with a ticket and no user id', async () => {
  MockSocket.reset();
  installMocks(0);
  const { LiveSessionClient } = await import('../src/lib/live-session');

  const client = new LiveSessionClient({
    settings: { guildId: 'g1', voiceChannelId: 'vc1', userId: 'u1', roleIds: 'dj' },
    onSession: () => {},
    onStatus: () => {},
  });

  client.connect();
  await flush();

  const socket = MockSocket.instances.at(-1);
  assert.ok(socket, 'a socket should have been opened');
  socket.emit('open');

  const frames = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const auth = frames.find((frame) => frame.op === 'auth');
  const subscribe = frames.find((frame) => frame.op === 'subscribe');

  assert.equal(auth?.ticket, 'signed-ticket');
  assert.equal(auth?.secret, undefined);
  assert.equal(subscribe?.userId, undefined);
  assert.equal(subscribe?.roleIds, undefined);

  client.disconnect();
});
