import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/gateway.ts';
import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

type VoiceCall = { guildId: string; channelId?: string; connectionId?: string | null; selfDeaf?: boolean | undefined };

function createGateway() {
  const events = new EventEmitter();
  return {
    joins: [] as VoiceCall[],
    leaves: [] as VoiceCall[],
    joinVoice(guildId: string, channelId: string, options: { selfDeaf?: boolean; connectionId?: string | null } = {}) {
      this.joins.push({ guildId, channelId, connectionId: options.connectionId ?? null, selfDeaf: options.selfDeaf });
    },
    leaveVoice(guildId: string, connectionId: string | null = null) {
      this.leaves.push({ guildId, connectionId });
    },
    on(event: string, listener: (data: unknown) => void) {
      events.on(event, listener);
    },
    off(event: string, listener: (data: unknown) => void) {
      events.off(event, listener);
    },
    emit(event: string, data: unknown) {
      events.emit(event, data);
    },
  };
}

function captureVoiceStateUpdates() {
  const gateway = new Gateway({ url: 'wss://gateway.example/', token: 'token', logger: null } as never) as never as {
    joinVoice: Gateway['joinVoice'];
    leaveVoice: Gateway['leaveVoice'];
    _send: (op: number, payload: unknown) => boolean;
  };
  const sent: Array<Record<string, unknown>> = [];
  gateway._send = (_op, payload) => {
    sent.push(payload as Record<string, unknown>);
    return true;
  };
  return { gateway, sent };
}

test('the gateway sends a connection id only when one is known', () => {
  const { gateway, sent } = captureVoiceStateUpdates();

  gateway.joinVoice('guild-1', 'voice-a');
  gateway.joinVoice('guild-1', 'voice-a', { connectionId: 'conn-1' });
  gateway.leaveVoice('guild-1', 'conn-1');
  gateway.leaveVoice('guild-1');

  assert.equal('connection_id' in sent[0]!, false, 'a fresh join must open a new connection');
  assert.equal(sent[1]!.connection_id, 'conn-1');
  assert.equal(sent[2]!.connection_id, 'conn-1');
  assert.equal(sent[2]!.channel_id, null);
  assert.equal('connection_id' in sent[3]!, false);
});

test('a voice grant for another channel of the same guild is ignored', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', { logger: null, connectTimeoutMs: 500 });

  const pending = connection._waitForVoiceServer('voice-a');
  gateway.emit('VOICE_SERVER_UPDATE', { guild_id: 'guild-1', channel_id: 'voice-b', connection_id: 'conn-b', token: 't', endpoint: 'wss://b' });
  gateway.emit('VOICE_SERVER_UPDATE', { guild_id: 'guild-1', channel_id: 'voice-a', connection_id: 'conn-a', token: 't', endpoint: 'wss://a' });

  const update = await pending;
  assert.equal(update.connection_id, 'conn-a');
});

test('disconnect releases only its own connection', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', { logger: null });
  connection.channelId = 'voice-a';
  connection.connectionId = 'conn-a';

  await connection.disconnect();

  assert.deepEqual(gateway.leaves, [{ guildId: 'guild-1', connectionId: 'conn-a' }]);
  assert.equal(connection.connectionId, null);
});

test('without a known connection id a sibling session keeps the guild voice state', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger: null,
    hasSiblingConnections: () => true,
  });

  await connection.disconnect();

  assert.deepEqual(gateway.leaves, []);
});

test('without a known connection id a lone session still leaves the guild', async () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', {
    logger: null,
    hasSiblingConnections: () => false,
  });

  await connection.disconnect();

  assert.deepEqual(gateway.leaves, [{ guildId: 'guild-1', connectionId: null }]);
});

test('updating the deaf state reuses the existing connection instead of opening one', () => {
  const gateway = createGateway();
  const connection = new VoiceConnection(gateway as never, 'guild-1', { logger: null });
  connection.room = { isConnected: true } as never;
  connection.channelId = 'voice-a';

  connection._syncVoiceDeafState();
  assert.equal(gateway.joins.length, 0, 'no update may be sent without a connection id');

  connection.connectionId = 'conn-a';
  connection._syncVoiceDeafState();
  assert.deepEqual(gateway.joins, [{ guildId: 'guild-1', channelId: 'voice-a', connectionId: 'conn-a', selfDeaf: true }]);
});
