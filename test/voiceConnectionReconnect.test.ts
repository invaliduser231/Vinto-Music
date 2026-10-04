import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomEvent } from '@livekit/rtc-node';

import { GATEWAY_OFFLINE_MESSAGE, VoiceConnection } from '../src/voice/VoiceConnection.ts';

function createGateway() {
  return {
    joinVoice() {},
    leaveVoiceCalls: 0,
    leaveVoice() {
      this.leaveVoiceCalls += 1;
    },
    on() {},
    off() {},
  };
}

type FakeRoom = {
  isConnected: boolean;
  listeners: Map<unknown, Array<(...args: unknown[]) => void>>;
  on(event: unknown, listener: (...args: unknown[]) => void): void;
  off(event: unknown, listener: (...args: unknown[]) => void): void;
  disconnect(): Promise<void>;
  removeAllListeners(): void;
  emitDisconnected(): void;
};

function createRoom(): FakeRoom {
  return {
    isConnected: true,
    listeners: new Map(),
    on(event, listener) {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
    },
    off(event, listener) {
      const existing = this.listeners.get(event) ?? [];
      this.listeners.set(event, existing.filter((entry) => entry !== listener));
    },
    async disconnect() {
      this.isConnected = false;
    },
    removeAllListeners() {
      this.listeners.clear();
    },
    emitDisconnected() {
      this.isConnected = false;
      for (const listener of this.listeners.get(RoomEvent.Disconnected) ?? []) {
        listener();
      }
    },
  };
}

// The reconnect loop uses exponential backoff, so tests shrink it to keep runtimes low.
function createConnection(gateway = createGateway()) {
  const connection = new VoiceConnection(gateway, 'guild-1', { logger: null });
  connection._reconnectBaseDelayMs = 1;
  connection._reconnectMaxDelayMs = 2;
  connection._reconnectMaxAttempts = 3;
  return connection;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  return predicate();
}

test('an unexpected room disconnect triggers a reconnect into the same channel', async () => {
  const connection = createConnection();
  const room = createRoom();

  const reconnectChannels: string[] = [];
  connection._connect = async (channelId: string) => {
    reconnectChannels.push(channelId);
    room.isConnected = true;
    connection.room = room as never;
    connection.channelId = channelId;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);

  room.emitDisconnected();

  assert.equal(await waitFor(() => reconnectChannels.length > 0), true);
  assert.deepEqual(reconnectChannels, ['voice-1']);
  assert.equal(connection.connected, true);
});

test('reconnect retries until a later attempt succeeds', async () => {
  const connection = createConnection();
  const room = createRoom();

  let attempts = 0;
  connection._connect = async (channelId: string) => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('Timeout waiting for VOICE_SERVER_UPDATE.');
    }
    room.isConnected = true;
    connection.room = room as never;
    connection.channelId = channelId;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);

  room.emitDisconnected();

  assert.equal(await waitFor(() => connection.connected), true);
  assert.equal(attempts, 3);
});

test('reconnect gives up after the attempt limit and reports the failure', async () => {
  const connection = createConnection();
  const room = createRoom();

  let failureNotices = 0;
  connection.onReconnectFailed = () => {
    failureNotices += 1;
  };

  let attempts = 0;
  connection._connect = async () => {
    attempts += 1;
    throw new Error('Voice server response is missing endpoint or token.');
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);

  room.emitDisconnected();

  assert.equal(await waitFor(() => failureNotices > 0), true);
  assert.equal(attempts, 3);
  assert.equal(connection.connected, false);
  assert.equal(connection._reconnectInProgress, false);
});

function createEmittingGateway() {
  const emitter = new EventEmitter();
  const state = { socketOpen: false, readyState: 3, hasSession: true, reconnectAttempts: 4, heartbeatLatencyMs: null };
  return {
    emitter,
    state,
    joinVoice() {},
    leaveVoice() {},
    describeConnectionState: () => ({ ...state }),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
    },
  };
}

function createGatewayAwareConnection(gateway: ReturnType<typeof createEmittingGateway>) {
  const connection = createConnection(gateway as never);
  connection._gatewayRecoveryPollMs = 5;
  connection._gatewayRecoverySettleMinMs = 0;
  connection._gatewayRecoverySettleMaxMs = 0;
  return connection;
}

test('a gateway outage pauses the reconnect until the gateway is ready again', async () => {
  const gateway = createEmittingGateway();
  const connection = createGatewayAwareConnection(gateway);
  const room = createRoom();
  let gatewayUp = false;

  let failureNotices = 0;
  connection.onReconnectFailed = () => {
    failureNotices += 1;
  };

  let joinAttempts = 0;
  connection._connect = async (channelId: string) => {
    joinAttempts += 1;
    if (!gatewayUp) throw new Error(GATEWAY_OFFLINE_MESSAGE);
    room.isConnected = true;
    connection.room = room as never;
    connection.channelId = channelId;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);
  room.emitDisconnected();

  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(joinAttempts, 1);
  assert.equal(failureNotices, 0);

  gatewayUp = true;
  gateway.emitter.emit('READY', {});

  assert.equal(await waitFor(() => connection.connected), true);
  assert.equal(joinAttempts, 2);
  assert.equal(failureNotices, 0);
});

test('the reconnect also notices a recovered gateway without seeing the ready event', async () => {
  const gateway = createEmittingGateway();
  const connection = createGatewayAwareConnection(gateway);
  const room = createRoom();

  connection._connect = async (channelId: string) => {
    if (!gateway.state.socketOpen) throw new Error(GATEWAY_OFFLINE_MESSAGE);
    room.isConnected = true;
    connection.room = room as never;
    connection.channelId = channelId;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);
  room.emitDisconnected();

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  Object.assign(gateway.state, { socketOpen: true, readyState: 1, reconnectAttempts: 0 });

  assert.equal(await waitFor(() => connection.connected), true);
});

test('the reconnect gives up when the gateway stays away past the wait limit', async () => {
  const gateway = createEmittingGateway();
  const connection = createGatewayAwareConnection(gateway);
  connection._gatewayRecoveryMaxWaitMs = 40;
  const room = createRoom();

  let failureNotices = 0;
  connection.onReconnectFailed = () => {
    failureNotices += 1;
  };
  connection._connect = async () => {
    throw new Error(GATEWAY_OFFLINE_MESSAGE);
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);
  room.emitDisconnected();

  assert.equal(await waitFor(() => failureNotices > 0), true);
  assert.equal(connection.connected, false);
  assert.equal(gateway.emitter.listenerCount('READY'), 0);
});

// A manual disconnect detaches the listener first, so the teardown must never rejoin.
test('a manual disconnect does not trigger a reconnect', async () => {
  const connection = createConnection();
  const room = createRoom();

  let connectCalls = 0;
  connection._connect = async () => {
    connectCalls += 1;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);

  await connection.disconnect();
  room.emitDisconnected();

  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(connectCalls, 0);
  assert.equal(connection.room, null);
  assert.equal(connection.channelId, null);
});

test('a disconnect from a stale room is ignored', async () => {
  const connection = createConnection();
  const staleRoom = createRoom();
  const activeRoom = createRoom();

  let connectCalls = 0;
  connection._connect = async () => {
    connectCalls += 1;
  };

  connection.room = staleRoom as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(staleRoom as never);
  connection.room = activeRoom as never;

  staleRoom.emitDisconnected();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(connectCalls, 0);
});

test('auto reconnect can be turned off per connection', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', {
    logger: null,
    autoReconnectEnabled: false,
  });
  const room = createRoom();

  let connectCalls = 0;
  connection._connect = async () => {
    connectCalls += 1;
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection._attachRoomListeners(room as never);

  room.emitDisconnected();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(connectCalls, 0);
});

// LiveKit closes the audio source during teardown, and a frame already in flight rejects with this message.
test('a closed audio source counts as a recoverable capture error', () => {
  const connection = createConnection();

  assert.equal(connection._isFatalCaptureError(new Error('AudioSource is closed')), true);
  assert.equal(connection._isClosedSourceError(new Error('AudioSource is closed')), true);
  assert.equal(connection._isClosedSourceError(new Error('InvalidState')), false);
});

// Retrying a closed source can never succeed, so the retry loop has to rethrow immediately.
test('capture retries stop immediately when the audio source is closed', async () => {
  const connection = createConnection();
  connection.audioPumpToken = 7;
  connection.room = { isConnected: true } as never;

  let captureCalls = 0;
  const source = {
    async captureFrame() {
      captureCalls += 1;
      throw new Error('AudioSource is closed');
    },
  };

  await assert.rejects(
    () => connection._captureFrameWithRetry(source as never, {} as never, 7),
    /AudioSource is closed/,
  );
  assert.equal(captureCalls, 1);
});

test('capture retries continue for a transient invalid state', async () => {
  const connection = createConnection();
  connection.audioPumpToken = 7;
  connection.room = { isConnected: true } as never;

  let captureCalls = 0;
  const source = {
    async captureFrame() {
      captureCalls += 1;
      if (captureCalls < 3) {
        throw new Error('InvalidState');
      }
    },
  };

  await connection._captureFrameWithRetry(source as never, {} as never, 7);

  assert.equal(captureCalls, 3);
});
