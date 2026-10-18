import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import type { SessionManager } from '../src/bot/sessionManager.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

const SHARD_0_GUILD = '1474874137937518680';
const SHARD_1_GUILD = '1485394316330348923';
const USER_ID = '100000000000000002';

function createServer(port: number) {
  const sessions = Object.assign(new EventEmitter(), { listByGuild: () => [], get: () => null });
  return new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port,
    secret: 'local-secret',
    sessions: sessions as unknown as SessionManager,
    voiceStateStore: new VoiceStateStore(),
    botUserId: 'bot-1',
    shardAssignment: { shardId: 1, shardCount: 2 },
    getGuildMember: async (_guildId, userId) => ({ user: { id: userId, username: 'member' } }),
  });
}

test('a shard answers 421 with the owner for a guild it does not serve', async () => {
  const server = createServer(19121);
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:19121/api/v1/guild?guildId=${SHARD_0_GUILD}`, {
      headers: { Authorization: 'Bearer local-secret', 'X-User-Id': USER_ID },
    });
    assert.equal(response.status, 421);
    assert.deepEqual(await response.json(), { error: 'guild belongs to another shard', shardId: 0 });
  } finally {
    await server.stop();
  }
});

test('a shard keeps serving its own guilds', async () => {
  const server = createServer(19122);
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:19122/api/v1/guild?guildId=${SHARD_1_GUILD}`, {
      headers: { Authorization: 'Bearer local-secret', 'X-User-Id': USER_ID },
    });
    assert.equal(response.status, 200);
  } finally {
    await server.stop();
  }
});

test('session actions for a foreign guild are refused before anything runs', async () => {
  const server = createServer(19123);
  await server.start();
  try {
    const response = await fetch('http://127.0.0.1:19123/api/v1/session/action', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'X-User-Id': USER_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ guildId: SHARD_0_GUILD, voiceChannelId: 'vc-1', action: 'pause' }),
    });
    assert.equal(response.status, 421);
  } finally {
    await server.stop();
  }
});

test('the shard hint is only given to an authorized caller', async () => {
  const server = createServer(19124);
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:19124/api/v1/guild?guildId=${SHARD_0_GUILD}`, {
      headers: { 'X-User-Id': USER_ID },
    });
    assert.equal(response.status, 401);
  } finally {
    await server.stop();
  }
});
