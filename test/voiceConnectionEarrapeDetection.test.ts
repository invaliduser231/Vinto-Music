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

test('earrape detector ignores isolated high-crest pop bursts', () => {
  const connection = new VoiceConnection(createGateway() as never, 'guild-1', { logger: null });
  const state = connection._ensureParticipantAudioState('user-1');
  state.joinedAtMs = 0;
  state.profileLoaded = true;
  state.baselineRms = 0.08;
  state.baselineFrames = 120;

  const popLikeFrame = {
    peak: 1.0,
    rms: 0.09,
    clippedSampleRatio: 0.01,
    crestFactor: 11.1,
  };

  for (let i = 0; i < 12; i += 1) {
    const triggered = connection._ingestParticipantFrame('user-1', popLikeFrame, 2_000 + (i * 20));
    assert.equal(triggered, null);
  }
});

test('earrape detector triggers on sustained clipped loud audio and enforces cooldown', () => {
  const connection = new VoiceConnection(createGateway() as never, 'guild-1', { logger: null });
  const state = connection._ensureParticipantAudioState('user-1');
  state.joinedAtMs = 0;
  state.profileLoaded = true;
  state.baselineRms = 0.07;
  state.baselineFrames = 120;

  const abusiveFrame = {
    peak: 0.99,
    rms: 0.62,
    clippedSampleRatio: 0.26,
    crestFactor: 1.6,
  };

  let firstTriggerAt: number | null = null;
  for (let i = 0; i < 40; i += 1) {
    const nowMs = 3_000 + (i * 20);
    const triggered = connection._ingestParticipantFrame('user-1', abusiveFrame, nowMs);
    if (triggered) {
      firstTriggerAt = nowMs;
      break;
    }
  }

  assert.ok(firstTriggerAt != null);

  const immediateRetry = connection._ingestParticipantFrame('user-1', abusiveFrame, (firstTriggerAt ?? 0) + 60);
  assert.equal(immediateRetry, null);

  const calmFrame = {
    peak: 0.06,
    rms: 0.03,
    clippedSampleRatio: 0,
    crestFactor: 2,
  };
  for (let i = 0; i < 24; i += 1) {
    connection._ingestParticipantFrame('user-1', calmFrame, (firstTriggerAt ?? 0) + 500 + (i * 20));
  }

  let secondTriggerAt: number | null = null;
  for (let i = 0; i < 60; i += 1) {
    const nowMs = (firstTriggerAt ?? 0) + 3_300 + (i * 20);
    const triggered = connection._ingestParticipantFrame('user-1', abusiveFrame, nowMs);
    if (triggered) {
      secondTriggerAt = nowMs;
      break;
    }
  }

  assert.ok(secondTriggerAt != null);
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

test('participant identities with embedded snowflakes are normalized to the user id', () => {
  const connection = new VoiceConnection(createGateway() as never, 'guild-1', { logger: null });

  const participantId = connection._normalizeParticipantId({
    identity: 'user_1474761291856015469_crane-cirius',
  });

  assert.equal(participantId, '1474761291856015469');
});
