import test from 'node:test';
import assert from 'node:assert/strict';

import { GATEWAY_OFFLINE_MESSAGE, VoiceConnection } from '../src/voice/VoiceConnection.ts';
import {
  connectPreparedSession,
  isGatewayOfflineVoiceFailure,
  isRetryableVoiceConnectFailure,
} from '../src/bot/commands/helpers/context.ts';

function createLogger() {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  return {
    warnings,
    logger: {
      warn(message: string, meta?: Record<string, unknown>) { warnings.push({ message, meta }); },
      info() {},
      error() {},
      debug() {},
    },
  };
}

function createGateway(joinResult: boolean | undefined) {
  const calls: string[] = [];
  return {
    calls,
    joinVoice() { calls.push('join'); return joinResult; },
    leaveVoice() { calls.push('leave'); return true; },
    describeConnectionState() {
      return {
        socketOpen: false,
        readyState: 3,
        hasSession: true,
        reconnectAttempts: 1,
        heartbeatLatencyMs: null,
      };
    },
    on() {},
    off() {},
  };
}

test('a join that was never sent fails immediately instead of waiting for the timeout', async () => {
  const gateway = createGateway(false);
  const { logger, warnings } = createLogger();
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger,
    connectTimeoutMs: 10_000,
  } as never);

  const startedAt = Date.now();
  await assert.rejects(connection._connect('voice-1'), /gateway socket is not open/i);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1_000, `it must not wait for the voice server timeout, waited ${elapsed}ms`);
  assert.deepEqual(gateway.calls, ['join'], 'nothing was sent, so there is no voice state to release');
  assert.equal(warnings.at(0)?.message, 'Voice join was not sent because the gateway socket is not open');
  assert.equal(warnings.at(0)?.meta?.socketOpen, false);
});

test('a failed send does not make the next attempt release a voice state it never claimed', async () => {
  const gateway = createGateway(false);
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger: null,
    connectTimeoutMs: 10_000,
  } as never);

  await assert.rejects(connection._connect('voice-1'));
  await assert.rejects(connection._connect('voice-1'));

  assert.deepEqual(gateway.calls, ['join', 'join']);
});

test('a gateway that reports no send result keeps the previous behaviour', async () => {
  const gateway = createGateway(undefined);
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger: null,
    connectTimeoutMs: 30,
  } as never);

  await assert.rejects(connection._connect('voice-1'), /Timeout waiting for VOICE_SERVER_UPDATE/);
  assert.deepEqual(gateway.calls, ['join', 'leave']);
});

test('a voice server timeout is logged with the gateway state', async () => {
  const gateway = createGateway(true);
  const { logger, warnings } = createLogger();
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger,
    connectTimeoutMs: 80,
  } as never);

  await assert.rejects(connection._connect('voice-1'), /Timeout waiting for VOICE_SERVER_UPDATE/);

  const timeoutWarning = warnings.find((entry) => entry.message === 'Timed out waiting for VOICE_SERVER_UPDATE');
  assert.ok(timeoutWarning, 'the timeout must leave a trace in the logs');
  assert.equal(timeoutWarning?.meta?.guildId, 'guild-1');
  assert.equal(timeoutWarning?.meta?.timeoutMs, 80);
  assert.equal(timeoutWarning?.meta?.socketOpen, false);
  assert.ok(Number(timeoutWarning?.meta?.waitedMs) >= 40, 'the waited time has to be reported');
});

test('an offline gateway is told apart from a silent voice server', () => {
  const offline = new Error(GATEWAY_OFFLINE_MESSAGE);
  const timeout = new Error('Timeout waiting for VOICE_SERVER_UPDATE.');

  assert.equal(isGatewayOfflineVoiceFailure(offline), true);
  assert.equal(isGatewayOfflineVoiceFailure(timeout), false);
  assert.equal(isRetryableVoiceConnectFailure(offline), true, 'the socket returns within seconds, so retry');
  assert.equal(isRetryableVoiceConnectFailure(timeout), true);
});

test('a user facing offline failure does not blame the voice server', async () => {
  const session = {
    sessionId: 's1',
    connection: {
      connected: false,
      async connect() { throw new Error(GATEWAY_OFFLINE_MESSAGE); },
    },
  } as never;

  const ctx = {
    guildId: 'guild-1',
    t: (key: string) => key,
    sessions: {
      adoptVoiceChannel: () => {},
      syncPersistentVoiceState: async () => {},
      destroy: async () => {},
    },
    rest: { getGuildMember: async () => ({ deaf: false }) },
    botUserId: 'bot-1',
  } as never;

  await assert.rejects(
    connectPreparedSession(ctx, {
      hadSession: true,
      hasUsablePlayer: true,
      resolvedVoice: 'vc-1',
      session,
    } as never),
    /errors.voiceGatewayOffline/,
  );
});
