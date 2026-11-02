import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

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

test('disconnect closes audio resources and clears room internals', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway, 'guild-1', { logger: null });

  let sourceCloseCalls = 0;
  let sourceClearQueueCalls = 0;
  const source = {
    clearQueue() {
      sourceClearQueueCalls += 1;
    },
    async close() {
      sourceCloseCalls += 1;
    },
  };

  const trackCloseArgs: boolean[] = [];
  const track = {
    async close(closeSource = true) {
      trackCloseArgs.push(closeSource);
      if (closeSource) {
        await source.close();
      }
    },
  };

  let roomDisconnectCalls = 0;
  let roomRemoveAllCalls = 0;
  const room = {
    async disconnect() {
      roomDisconnectCalls += 1;
    },
    removeAllListeners() {
      roomRemoveAllCalls += 1;
    },
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';
  connection.audioSource = source as never;
  connection.audioTrack = track as never;
  connection.audioTrackSid = 'track-1';

  await connection.disconnect();

  assert.equal(gateway.leaveVoiceCalls, 1);
  assert.equal(roomDisconnectCalls, 1);
  assert.equal(roomRemoveAllCalls, 1);
  assert.deepEqual(trackCloseArgs, [false]);
  assert.equal(sourceClearQueueCalls, 2);
  assert.equal(sourceCloseCalls, 1);
  assert.equal(connection.room, null);
  assert.equal(connection.channelId, null);
  assert.equal(connection.audioSource, null);
  assert.equal(connection.audioTrack, null);
  assert.equal(connection.audioTrackSid, null);
});

test('_cleanupFailedConnect removes dangling ffi listener and pre-connect events', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway, 'guild-1', { logger: null });
  const originalFfiClient = Reflect.get(globalThis, '_ffiClientInstance') as EventEmitter | undefined;
  const ffiClient = new EventEmitter();

  Reflect.set(globalThis, '_ffiClientInstance', ffiClient);

  try {
    let sourceCloseCalls = 0;
    const source = {
      clearQueue() {},
      async close() {
        sourceCloseCalls += 1;
      },
    };

    let trackCloseCalls = 0;
    const track = {
      async close(closeSource = true) {
        trackCloseCalls += 1;
        if (closeSource) {
          await source.close();
        }
      },
    };

    let disconnectCalls = 0;
    let removeAllCalls = 0;
    const onFfiEvent = () => {};
    const room = {
      preConnectEvents: [{ ev: 1 }, { ev: 2 }],
      onFfiEvent,
      async disconnect() {
        disconnectCalls += 1;
      },
      removeAllListeners() {
        removeAllCalls += 1;
      },
    };

    ffiClient.on('ffi_event', onFfiEvent);

    connection.room = room as never;
    connection.audioSource = source as never;
    connection.audioTrack = track as never;
    connection.audioTrackSid = 'track-1';

    await connection._cleanupFailedConnect(room as never);

    assert.equal(disconnectCalls, 1);
    assert.equal(removeAllCalls, 1);
    assert.equal(ffiClient.listenerCount('ffi_event'), 0);
    assert.equal(room.preConnectEvents.length, 0);
    assert.equal(trackCloseCalls, 1);
    assert.equal(sourceCloseCalls, 1);
    assert.equal(gateway.leaveVoiceCalls, 1);
    assert.equal(connection.room, null);
    assert.equal(connection.audioSource, null);
    assert.equal(connection.audioTrack, null);
    assert.equal(connection.audioTrackSid, null);
  } finally {
    if (originalFfiClient) {
      Reflect.set(globalThis, '_ffiClientInstance', originalFfiClient);
    } else {
      Reflect.deleteProperty(globalThis, '_ffiClientInstance');
    }
  }
});

test('_closeAudioResources closes the source even when the track handle is already gone', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });

  let sourceCloseCalls = 0;
  const source = {
    clearQueue() {},
    async close() {
      sourceCloseCalls += 1;
    },
  };
  const track = {
    async close() {
      throw new Error('trying to drop an invalid handle');
    },
  };

  connection.audioSource = source as never;
  connection.audioTrack = track as never;
  connection.audioTrackSid = 'track-1';

  await connection._closeAudioResources();

  assert.equal(sourceCloseCalls, 1);
  assert.equal(connection.audioSource, null);
  assert.equal(connection.audioTrack, null);
});

test('_discardStaleRoom releases the audio source of the discarded room', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });

  let sourceCloseCalls = 0;
  const source = {
    clearQueue() {},
    async close() {
      sourceCloseCalls += 1;
    },
  };
  const track = {
    async close() {},
  };
  const room = {
    async disconnect() {},
    removeAllListeners() {},
  };

  connection.room = room as never;
  connection.audioSource = source as never;
  connection.audioTrack = track as never;
  connection.audioTrackSid = 'track-1';

  assert.equal(await connection._discardStaleRoom(), true);
  assert.equal(sourceCloseCalls, 1);
  assert.equal(connection.room, null);
  assert.equal(connection.audioSource, null);
  assert.equal(connection.audioTrackSid, null);
});

test('disconnect disposes the native room and publication handles', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });

  const disposed: string[] = [];
  const publications = new Map([
    ['pub-1', { ffiHandle: { dispose: () => disposed.push('publication') } }],
  ]);
  const room = {
    ffiHandle: {
      dispose() {
        disposed.push('room');
        throw new Error('trying to drop an invalid handle');
      },
    } as { dispose(): void } | undefined,
    localParticipant: { trackPublications: publications },
    async disconnect() {},
    removeAllListeners() {},
  };

  connection.room = room as never;
  connection.channelId = 'voice-1';

  await connection.disconnect();

  assert.deepEqual(disposed, ['publication', 'room']);
  assert.equal(room.ffiHandle, undefined);
  assert.equal(publications.size, 0);
  assert.equal(connection.room, null);
});
