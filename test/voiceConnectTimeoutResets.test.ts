import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

function createGateway() {
  const calls: Array<{ op: string; guildId: string }> = [];
  return {
    calls,
    joinVoice(guildId: string) { calls.push({ op: 'join', guildId }); },
    leaveVoice(guildId: string) { calls.push({ op: 'leave', guildId }); },
    on() {},
    off() {},
  };
}

function createConnection(gateway: ReturnType<typeof createGateway>) {
  return new VoiceConnection(gateway as never, 'guild-1', {
    logger: null,
    connectTimeoutMs: 40,
  } as never);
}

test('a voice server timeout releases the gateway voice state', async () => {
  const gateway = createGateway();
  const connection = createConnection(gateway);

  await assert.rejects(
    connection._connect('voice-1'),
    /Timeout waiting for VOICE_SERVER_UPDATE/,
  );

  assert.deepEqual(
    gateway.calls.map((entry) => entry.op),
    ['join', 'leave'],
    'a failed attempt must not leave the gateway thinking the bot is still joining',
  );
});

test('a retry after a timeout issues a fresh join', async () => {
  const gateway = createGateway();
  const connection = createConnection(gateway);

  await assert.rejects(connection._connect('voice-1'));
  await assert.rejects(connection._connect('voice-1'));

  assert.deepEqual(
    gateway.calls.map((entry) => entry.op),
    ['join', 'leave', 'join', 'leave'],
    'every attempt must start from a released voice state',
  );
});

test('an incomplete voice server payload also releases the state', async () => {
  const gateway = createGateway();
  const connection = createConnection(gateway);
  connection._waitForVoiceServer = async () => ({ guild_id: 'guild-1', endpoint: '', token: '' }) as never;

  await assert.rejects(connection._connect('voice-1'), /missing endpoint or token/);
  assert.deepEqual(gateway.calls.map((entry) => entry.op), ['join', 'leave']);
});

test('a gateway that throws on leave does not mask the original failure', async () => {
  const gateway = createGateway();
  gateway.leaveVoice = () => { throw new Error('gateway is gone'); };
  const connection = createConnection(gateway);

  await assert.rejects(
    connection._connect('voice-1'),
    /Timeout waiting for VOICE_SERVER_UPDATE/,
  );
});
