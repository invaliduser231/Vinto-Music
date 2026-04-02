import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

const FRAME_BYTES = 48_000 * 2 * 2 * 20 / 1000;

class ControlledPcmStream {
  chunks: Buffer[];
  pauseCalls: number;
  resumeCalls: number;
  paused: boolean;
  destroyed: boolean;

  constructor(chunks: Buffer[]) {
    this.chunks = [...chunks];
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.paused = false;
    this.destroyed = false;
  }

  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }

  resume() {
    this.paused = false;
    this.resumeCalls += 1;
  }

  destroy() {
    this.destroyed = true;
  }

  async *[Symbol.asyncIterator]() {
    while (this.chunks.length > 0) {
      while (this.paused && !this.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (this.destroyed) return;
      yield this.chunks.shift()!;
    }
  }
}

function createGateway() {
  return {
    joinVoice() {},
    leaveVoice() {},
    on() {},
    off() {},
  };
}

test('_pumpPcmStream applies input backpressure when pending PCM grows too large', async () => {
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger: null });
  const oversizedChunk = Buffer.alloc(FRAME_BYTES * 70);
  const stream = new ControlledPcmStream([oversizedChunk, Buffer.alloc(FRAME_BYTES)]);
  const source = {
    queuedDuration: 1300,
    waitForPlayoutCalls: 0,
    capturedFrames: 0,
    async waitForPlayout() {
      this.waitForPlayoutCalls += 1;
      this.queuedDuration = 0;
    },
    async captureFrame() {
      this.capturedFrames += 1;
      this.queuedDuration = 0;
    },
  };

  connection.audioPumpToken = 1;
  connection.currentAudioStream = stream;
  await connection._pumpPcmStream(stream, source as never, 1);

  assert.ok(stream.pauseCalls >= 1);
  assert.ok(stream.resumeCalls >= 1);
  assert.ok(source.waitForPlayoutCalls >= 1);
  assert.ok(source.capturedFrames >= 2);
  assert.equal(connection.currentAudioStream, null);
});
