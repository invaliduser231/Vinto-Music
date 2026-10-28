import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/gateway.ts';
import { dispatchGuildId, shouldDeliverDispatch } from '../src/core/sharding.ts';

const SHARD_0_GUILD = '1474874137937518680';
const SHARD_1_GUILD = '1485394316330348923';
const TWO_SHARDS_ZERO = { shardId: 0, shardCount: 2 };
const TWO_SHARDS_ONE = { shardId: 1, shardCount: 2 };

type LoggedLine = { message: string; meta: Record<string, unknown> };

function createGateway(shardId: number, shardCount: number) {
  const logged: LoggedLine[] = [];
  const gateway = new Gateway({
    url: 'wss://gateway.example/',
    token: 'token',
    shardId,
    shardCount,
    logger: {
      info: (message: string, meta: Record<string, unknown> = {}) => logged.push({ message, meta }),
      warn: () => undefined,
    },
  });
  const internal = gateway as unknown as {
    _handlePacket: (packet: unknown) => void;
    _scheduleSequenceAckHeartbeat: () => void;
    sequence: number | null;
  };
  internal._scheduleSequenceAckHeartbeat = () => undefined;
  return { gateway, internal, logged };
}

function dispatch(internal: { _handlePacket: (packet: unknown) => void }, t: string, d: unknown, s: number) {
  internal._handlePacket({ op: 0, t, d, s });
}

test('the guild of a dispatch comes from guild_id, or from id for guild lifecycle events', () => {
  assert.equal(dispatchGuildId('MESSAGE_CREATE', { guild_id: SHARD_1_GUILD, id: '42' }), SHARD_1_GUILD);
  assert.equal(dispatchGuildId('GUILD_CREATE', { id: SHARD_1_GUILD }), SHARD_1_GUILD);
  assert.equal(dispatchGuildId('GUILD_DELETE', { id: SHARD_1_GUILD, unavailable: true }), SHARD_1_GUILD);
  assert.equal(dispatchGuildId('MESSAGE_CREATE', { id: '42', channel_id: '7' }), null);
  assert.equal(dispatchGuildId('MESSAGE_CREATE', null), null);
});

test('guild events only reach the shard that owns the guild', () => {
  const message = { guild_id: SHARD_1_GUILD, content: '!play' };
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', message, TWO_SHARDS_ZERO), false);
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', message, TWO_SHARDS_ONE), true);
  assert.equal(shouldDeliverDispatch('VOICE_SERVER_UPDATE', { guild_id: SHARD_0_GUILD }, TWO_SHARDS_ZERO), true);
  assert.equal(shouldDeliverDispatch('VOICE_SERVER_UPDATE', { guild_id: SHARD_0_GUILD }, TWO_SHARDS_ONE), false);
});

test('events without a guild are handled on shard 0 only, session lifecycle on every shard', () => {
  const directMessage = { channel_id: '7', content: 'hi' };
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', directMessage, TWO_SHARDS_ZERO), true);
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', directMessage, TWO_SHARDS_ONE), false);
  assert.equal(shouldDeliverDispatch('READY', { guilds: [] }, TWO_SHARDS_ONE), true);
  assert.equal(shouldDeliverDispatch('RESUMED', null, TWO_SHARDS_ONE), true);
});

test('a single shard delivers everything', () => {
  const single = { shardId: 0, shardCount: 1 };
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', { guild_id: SHARD_1_GUILD }, single), true);
  assert.equal(shouldDeliverDispatch('MESSAGE_CREATE', { channel_id: '7' }, single), true);
});

test('shard 0 drops events of a guild that Fluxer leaked to every session after a join', () => {
  const { gateway, internal, logged } = createGateway(0, 2);
  const received: string[] = [];
  gateway.on('MESSAGE_CREATE', (payload: { guild_id?: string }) => received.push(String(payload.guild_id)));
  gateway.on('GUILD_CREATE', (payload: { id?: string }) => received.push(`guild:${String(payload.id)}`));

  dispatch(internal, 'GUILD_CREATE', { id: SHARD_1_GUILD }, 10);
  dispatch(internal, 'MESSAGE_CREATE', { guild_id: SHARD_1_GUILD, content: '!play' }, 11);
  dispatch(internal, 'MESSAGE_CREATE', { guild_id: SHARD_1_GUILD, content: '!skip' }, 12);
  dispatch(internal, 'MESSAGE_CREATE', { guild_id: SHARD_0_GUILD, content: '!play' }, 13);

  assert.deepEqual(received, [SHARD_0_GUILD]);
  assert.equal(internal.sequence, 13, 'dropped events still advance the sequence so a resume stays correct');
  const notices = logged.filter((line) => line.message === 'Ignoring events for a guild owned by another shard');
  assert.equal(notices.length, 1, 'a leaked guild is logged once, not per event');
  assert.equal(notices[0]?.meta.guildId, SHARD_1_GUILD);
  assert.equal(notices[0]?.meta.ownerShardId, 1);
});

test('the owning shard still receives the events of its guild', () => {
  const { gateway, internal } = createGateway(1, 2);
  const received: string[] = [];
  gateway.on('MESSAGE_CREATE', (payload: { guild_id?: string }) => received.push(String(payload.guild_id)));

  dispatch(internal, 'MESSAGE_CREATE', { guild_id: SHARD_1_GUILD, content: '!play' }, 1);
  dispatch(internal, 'MESSAGE_CREATE', { guild_id: SHARD_0_GUILD, content: '!play' }, 2);

  assert.deepEqual(received, [SHARD_1_GUILD]);
});

test('the owning shard logs joins and leaves, but not guilds it already had at ready', () => {
  const { internal, logged } = createGateway(0, 2);
  const OTHER_SHARD_0_GUILD = '1488115521506995110';

  dispatch(internal, 'READY', { session_id: 's', guilds: [{ id: SHARD_0_GUILD, unavailable: true }] }, 1);
  dispatch(internal, 'GUILD_CREATE', { id: SHARD_0_GUILD }, 2);
  dispatch(internal, 'GUILD_CREATE', { id: OTHER_SHARD_0_GUILD }, 3);
  dispatch(internal, 'GUILD_CREATE', { id: OTHER_SHARD_0_GUILD }, 4);
  dispatch(internal, 'GUILD_DELETE', { id: SHARD_0_GUILD, unavailable: true }, 5);
  dispatch(internal, 'GUILD_DELETE', { id: OTHER_SHARD_0_GUILD }, 6);

  const membership = logged
    .filter((line) => line.message === 'Joined guild' || line.message === 'Left guild')
    .map((line) => `${line.message}:${String(line.meta.guildId)}`);
  assert.deepEqual(membership, [
    `Joined guild:${OTHER_SHARD_0_GUILD}`,
    `Left guild:${OTHER_SHARD_0_GUILD}`,
  ]);
});
