import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

function createGateway() {
  const joinCalls: Array<{ guildId: string; channelId: string; selfDeaf: boolean }> = [];
  return {
    joinCalls,
    joinVoice(guildId: string, channelId: string, options: { selfDeaf?: boolean } = {}) {
      joinCalls.push({
        guildId,
        channelId,
        selfDeaf: options.selfDeaf !== false,
      });
    },
    leaveVoice() {},
    on() {},
    off() {},
  };
}

test('earrape protection toggles the gateway self_deaf voice state for active sessions', () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', { logger: null });

  connection.room = { isConnected: true } as never;
  connection.channelId = 'voice-1';

  connection.setEarrapeProtectionEnabled(true);
  connection.setEarrapeProtectionEnabled(false);

  assert.deepEqual(gateway.joinCalls, [
    { guildId: 'guild-1', channelId: 'voice-1', selfDeaf: false },
    { guildId: 'guild-1', channelId: 'voice-1', selfDeaf: true },
  ]);
});

test('earrape peak ingestion requires consecutive frames and enforces cooldown', () => {
  const connection = new VoiceConnection(createGateway() as never, 'guild-1', { logger: null });

  assert.equal(connection._ingestParticipantPeak('user-1', 0.39, 0), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.40, 20), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.41, 40), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.42, 60), true);

  assert.equal(connection._ingestParticipantPeak('user-1', 0.10, 200), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.10, 320), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.10, 540), false);

  assert.equal(connection._ingestParticipantPeak('user-1', 0.45, 600), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.45, 620), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.45, 640), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.45, 660), false);

  assert.equal(connection._ingestParticipantPeak('user-1', 0.46, 2_600), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.46, 2_620), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.46, 2_640), false);
  assert.equal(connection._ingestParticipantPeak('user-1', 0.46, 2_660), true);
});

test('earrape frame peak calculation normalizes int16 PCM values', () => {
  const connection = new VoiceConnection(createGateway() as never, 'guild-1', { logger: null });
  const frame = {
    data: new Int16Array([0, 1_024, -24_000, 32_767]),
  };

  const peak = connection._computeFramePeak(frame);
  assert.ok(peak > 0.99);
  assert.ok(peak <= 1);
});
