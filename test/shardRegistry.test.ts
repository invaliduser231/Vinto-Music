import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ShardRegistry, type ShardRegistryCollection, type ShardStats } from '../src/bot/services/shardRegistry.ts';
import { DashboardServer } from '../src/monitoring/dashboardServer.ts';
import type { SessionManager } from '../src/bot/sessionManager.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';
import { loadConfig } from '../src/config.ts';

type Doc = Record<string, unknown>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object' && '$gte' in expected) {
      return actual instanceof Date && expected.$gte instanceof Date && actual.getTime() >= expected.$gte.getTime();
    }
    return actual === expected;
  });
}

function createCollection() {
  const docs: Doc[] = [];
  const collection: ShardRegistryCollection = {
    createIndex: () => undefined,
    findOne: async (filter) => docs.find((doc) => matches(doc, filter)) ?? null,
    find: (filter) => {
      const cursor = {
        sort: () => cursor,
        toArray: async () => docs.filter((doc) => matches(doc, filter)).sort((a, b) => Number(a.shardId) - Number(b.shardId)),
      };
      return cursor;
    },
    updateOne: async (filter, update) => {
      const set = (update.$set ?? {}) as Doc;
      const existing = docs.find((doc) => matches(doc, filter));
      if (existing) Object.assign(existing, set);
      else docs.push({ ...filter, ...set });
      return undefined;
    },
    deleteOne: async (filter) => {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index >= 0) docs.splice(index, 1);
      return undefined;
    },
  };
  return { collection, docs };
}

function createRegistry(
  collection: ShardRegistryCollection,
  shardId: number,
  clock: { now: Date },
  logged: string[] = [],
  stats: ShardStats | null = null,
) {
  return new ShardRegistry({
    collection,
    assignment: { shardId, shardCount: 2 },
    dashboardUrl: `http://app-shard-${shardId}:9092`,
    stats: () => stats,
    now: () => clock.now,
    logger: { error: (message: string) => logged.push(message) },
  });
}

test('every shard announces its dashboard address and the directory lists the live ones', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  await createRegistry(collection, 1, clock).heartbeat();
  const zero = createRegistry(collection, 0, clock);
  await zero.heartbeat();

  const records = await zero.list();
  assert.deepEqual(records.map((record) => [record.shardId, record.shardCount, record.dashboardUrl]), [
    [0, 2, 'http://app-shard-0:9092'],
    [1, 2, 'http://app-shard-1:9092'],
  ]);
});

test('a shard without a recent heartbeat drops out of the directory', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  await createRegistry(collection, 1, clock).heartbeat();
  const zero = createRegistry(collection, 0, clock);

  clock.now = new Date('2026-10-18T12:00:45Z');
  await zero.heartbeat();

  assert.deepEqual((await zero.list()).map((record) => record.shardId), [0]);
});

test('a leftover record from a stopped process is not reported as a conflict', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const logged: string[] = [];
  await createRegistry(collection, 0, clock).heartbeat();

  const restarted = createRegistry(collection, 0, clock, logged);
  clock.now = new Date('2026-10-18T12:00:05Z');
  await restarted.heartbeat();
  clock.now = new Date('2026-10-18T12:00:15Z');
  await restarted.heartbeat();

  assert.deepEqual(logged, []);
});

test('a second process with the same shard id is reported once', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const logged: string[] = [];
  const first = createRegistry(collection, 1, clock);
  const second = createRegistry(collection, 1, clock, logged);

  await first.heartbeat();
  await second.heartbeat();
  await first.heartbeat();
  await second.heartbeat();

  assert.deepEqual(logged, ['Another process is running with the same shard id']);
});

test('stopping removes only the record this process wrote', async () => {
  const { collection, docs } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const replaced = createRegistry(collection, 1, clock);
  const current = createRegistry(collection, 1, clock);

  await replaced.heartbeat();
  await current.heartbeat();
  await replaced.stop();
  assert.equal(docs.length, 1, 'a replaced process must not delete the record of its successor');

  await current.stop();
  assert.equal(docs.length, 0);
});

test('the bot api serves the shard directory to the dashboard and skips shards without an api', async () => {
  const sessions = Object.assign(new EventEmitter(), { listByGuild: () => [], get: () => null });
  const heartbeatAt = new Date('2026-10-18T12:00:00Z');
  const server = new DashboardServer({
    enabled: true,
    host: '127.0.0.1',
    port: 19131,
    secret: 'local-secret',
    sessions: sessions as unknown as SessionManager,
    voiceStateStore: new VoiceStateStore(),
    listShards: async () => [{
      shardId: 0,
      shardCount: 2,
      dashboardUrl: null,
      instanceId: 'without-api',
      startedAt: heartbeatAt,
      heartbeatAt,
      stats: null,
    }, {
      shardId: 1,
      shardCount: 2,
      dashboardUrl: 'http://app-shard-1:9092',
      instanceId: 'internal',
      startedAt: heartbeatAt,
      heartbeatAt,
      stats: { guildCount: 1, memberCount: 2, uncountedGuildCount: 0 },
    }],
  });
  await server.start();
  try {
    const unauthorized = await fetch('http://127.0.0.1:19131/api/v1/shards');
    assert.equal(unauthorized.status, 401);

    const response = await fetch('http://127.0.0.1:19131/api/v1/shards', {
      headers: { Authorization: 'Bearer local-secret' },
    });
    const payload = await response.json() as { shards?: unknown[] };
    assert.equal(response.status, 200);
    assert.deepEqual(payload.shards, [{
      shardId: 1,
      shardCount: 2,
      url: 'http://app-shard-1:9092',
      heartbeatAt: heartbeatAt.toISOString(),
    }]);
  } finally {
    await server.stop();
  }
});

test('the advertised dashboard address defaults to the local port and must be http', () => {
  const base = { BOT_TOKEN: 'test-token', MONGODB_URI: 'mongodb://127.0.0.1:27017/test' };
  assert.equal(loadConfig({ ...base, DASHBOARD_API_PORT: '9100' }).dashboardApiAdvertiseUrl, 'http://127.0.0.1:9100');
  assert.equal(loadConfig({ ...base, DASHBOARD_API_ADVERTISE_URL: 'http://app-shard-1:9092/' }).dashboardApiAdvertiseUrl, 'http://app-shard-1:9092');
  assert.throws(() => loadConfig({ ...base, DASHBOARD_API_ADVERTISE_URL: 'app-shard-1:9092' }), /DASHBOARD_API_ADVERTISE_URL/);
  assert.throws(() => loadConfig({ ...base, DASHBOARD_API_ADVERTISE_URL: 'ftp://app:21' }), /DASHBOARD_API_ADVERTISE_URL/);
});

test('totals add up the counts every shard reported in its heartbeat', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const zero = createRegistry(collection, 0, clock, [], { guildCount: 988, memberCount: 120_000, uncountedGuildCount: 2 });
  await createRegistry(collection, 1, clock, [], { guildCount: 989, memberCount: 130_000, uncountedGuildCount: 1 }).heartbeat();
  await zero.heartbeat();

  assert.deepEqual(await zero.totals(), { shardCount: 2, guildCount: 1977, memberCount: 250_000, uncountedGuildCount: 3 });
});

test('totals stay unknown while a shard is missing, stale or still loading its guilds', async () => {
  const { collection } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const zero = createRegistry(collection, 0, clock, [], { guildCount: 988, memberCount: 1, uncountedGuildCount: 0 });
  await zero.heartbeat();
  assert.equal(await zero.totals(), null);

  await createRegistry(collection, 1, clock).heartbeat();
  assert.equal(await zero.totals(), null);

  await createRegistry(collection, 1, clock, [], { guildCount: 5, memberCount: 5, uncountedGuildCount: 0 }).heartbeat();
  clock.now = new Date('2026-10-18T12:00:45Z');
  await zero.heartbeat();
  assert.equal(await zero.totals(), null);
});

test('a shard without the dashboard api still joins the registry for the totals', async () => {
  const { collection, docs } = createCollection();
  const clock = { now: new Date('2026-10-18T12:00:00Z') };
  const registry = new ShardRegistry({
    collection,
    assignment: { shardId: 0, shardCount: 1 },
    dashboardUrl: null,
    stats: () => ({ guildCount: 3, memberCount: 30, uncountedGuildCount: 0 }),
    now: () => clock.now,
  });
  await registry.heartbeat();

  assert.equal(docs[0]?.dashboardUrl, null);
  assert.deepEqual(await registry.totals(), { shardCount: 1, guildCount: 3, memberCount: 30, uncountedGuildCount: 0 });
});
