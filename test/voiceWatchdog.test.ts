import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REMOVALS_PER_WINDOW,
  handleBotVoiceRemoval,
  queuePendingRestore,
  runVoiceWatchdogSweep,
  watchdogBackoffMs,
  type PendingRestore,
  type WatchdogHost,
} from '../src/bot/sessionManager/voiceWatchdog.ts';
import type { Session } from '../src/types/domain.ts';

type FakeConnection = {
  connected: boolean;
  channelId: string | null;
  connectionId: string | null;
  connectingPromise: Promise<unknown> | null;
  _reconnectInProgress: boolean;
  reconnects: string[];
  rejoins: string[];
  _runAutoReconnect: (channelId: string) => Promise<void>;
  forceRejoin: (channelId: string) => Promise<void>;
};

function createConnection(overrides: Partial<FakeConnection> = {}): FakeConnection {
  const connection: FakeConnection = {
    connected: true,
    channelId: '1000001',
    connectionId: 'conn-1',
    connectingPromise: null,
    _reconnectInProgress: false,
    reconnects: [],
    rejoins: [],
    async _runAutoReconnect(channelId) {
      connection.reconnects.push(channelId);
    },
    async forceRejoin(channelId) {
      connection.rejoins.push(channelId);
    },
    ...overrides,
  };
  return connection;
}

function createSession(connection: FakeConnection, stayInVoice: boolean, sessionId = 'g1:1000001'): Session {
  return {
    sessionId,
    guildId: 'g1',
    connection,
    player: {},
    settings: { stayInVoiceEnabled: stayInVoice },
  } as unknown as Session;
}

function createHost(sessions: Session[], restore: WatchdogHost['_restorePersistentBinding'] = async () => ({ restored: true })) {
  const destroyed: Array<{ sessionId: string; reason: string | undefined }> = [];
  const map = new Map(sessions.map((session) => [String(session.sessionId), session]));
  const host: WatchdogHost = {
    sessions: map,
    pendingRestores: new Map<string, PendingRestore>(),
    logger: null,
    listByGuild: (guildId) => [...map.values()].filter((session) => session.guildId === guildId),
    has: (guildId, selector) => [...map.values()].some((session) => (
      session.guildId === guildId && session.connection.channelId === selector.voiceChannelId
    )),
    async destroy(_guildId, reason, selector) {
      destroyed.push({ sessionId: String(selector?.sessionId), reason });
      map.delete(String(selector?.sessionId));
      return true;
    },
    _hasSessionInstance: (session) => [...map.values()].includes(session as Session),
    _restorePersistentBinding: restore,
  };
  return { host, destroyed };
}

test('watchdog backoff grows and caps at one hour', () => {
  assert.equal(watchdogBackoffMs(1), 2 * 60_000);
  assert.equal(watchdogBackoffMs(3), 8 * 60_000);
  assert.equal(watchdogBackoffMs(5), 32 * 60_000);
  assert.equal(watchdogBackoffMs(9), 60 * 60_000);
});

test('removal of a regular session closes it instead of rejoining', async () => {
  const connection = createConnection();
  const { host, destroyed } = createHost([createSession(connection, false)]);

  const outcome = await handleBotVoiceRemoval(host, {
    guildId: 'g1', userId: 'bot', channelId: null, previousChannelId: '1000001', mute: false, connectionId: 'conn-1',
  });

  assert.equal(outcome, 'closed');
  assert.deepEqual(destroyed, [{ sessionId: 'g1:1000001', reason: 'removed_from_voice' }]);
  assert.deepEqual(connection.rejoins, []);
});

test('removal of a 24/7 session rejoins until the removal limit is hit', async () => {
  const connection = createConnection();
  const { host, destroyed } = createHost([createSession(connection, true)]);
  const change = { guildId: 'g1', userId: 'bot', channelId: null, previousChannelId: '1000001', mute: false, connectionId: 'conn-1' };

  for (let index = 1; index < MAX_REMOVALS_PER_WINDOW; index += 1) {
    assert.equal(await handleBotVoiceRemoval(host, change, 1_000 * index), 'rejoining');
  }
  assert.equal(connection.rejoins.length, MAX_REMOVALS_PER_WINDOW - 1);

  assert.equal(await handleBotVoiceRemoval(host, change, 10_000), 'closed');
  assert.deepEqual(destroyed, [{ sessionId: 'g1:1000001', reason: 'removed_from_voice_repeatedly' }]);
});

test('voice state for a released or foreign connection is ignored', async () => {
  const released = createConnection({ connectionId: null });
  const { host, destroyed } = createHost([createSession(released, false)]);

  assert.equal(await handleBotVoiceRemoval(host, {
    guildId: 'g1', userId: 'bot', channelId: null, previousChannelId: '1000001', mute: false, connectionId: 'conn-1',
  }), 'ignored');

  const active = createConnection({ connectionId: 'conn-2' });
  const other = createHost([createSession(active, false)]);
  assert.equal(await handleBotVoiceRemoval(other.host, {
    guildId: 'g1', userId: 'bot', channelId: null, previousChannelId: '1000001', mute: false, connectionId: 'conn-1',
  }), 'ignored');

  assert.deepEqual(destroyed, []);
  assert.deepEqual(other.destroyed, []);
});

test('sweep reconnects disconnected 24/7 sessions with backoff', async () => {
  const connection = createConnection({ connected: false });
  const { host } = createHost([createSession(connection, true)]);

  await runVoiceWatchdogSweep(host, 0);
  assert.deepEqual(connection.reconnects, ['1000001']);

  await runVoiceWatchdogSweep(host, 60_000);
  assert.equal(connection.reconnects.length, 1);

  await runVoiceWatchdogSweep(host, 2 * 60_000);
  assert.equal(connection.reconnects.length, 2);
});

test('sweep leaves regular and reconnecting sessions alone', async () => {
  const regular = createConnection({ connected: false });
  const busy = createConnection({ connected: false, _reconnectInProgress: true, channelId: '1000002' });
  const { host } = createHost([
    createSession(regular, false),
    createSession(busy, true, 'g1:1000002'),
  ]);

  await runVoiceWatchdogSweep(host, 0);
  assert.deepEqual(regular.reconnects, []);
  assert.deepEqual(busy.reconnects, []);
});

test('sweep retries failed restores until one succeeds', async () => {
  let attempts = 0;
  const { host } = createHost([], async () => {
    attempts += 1;
    return { restored: attempts >= 2 };
  });
  const binding = { guildId: 'g1', voiceChannelId: '1000009', textChannelId: null };

  queuePendingRestore(host, binding, 0);
  await runVoiceWatchdogSweep(host, 60_000);
  assert.equal(attempts, 0);

  await runVoiceWatchdogSweep(host, 2 * 60_000);
  assert.equal(attempts, 1);
  assert.equal(host.pendingRestores.get('g1:1000009')?.failures, 2);

  await runVoiceWatchdogSweep(host, 2 * 60_000 + 4 * 60_000);
  assert.equal(attempts, 2);
  assert.equal(host.pendingRestores.size, 0);
});
