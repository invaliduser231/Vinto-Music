import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShardDirectorySnapshot, ShardDirectory, shardForGuild } from '../src/lib/shard-directory';

const BOOTSTRAP = 'http://app:9092';
const SHARD_0_GUILD = '1474874137937518680';
const SHARD_1_GUILD = '1485394316330348923';

function entry(shardId: number, shardCount: number, url: string, heartbeatAt = '2026-10-18T12:00:00.000Z') {
  return { shardId, shardCount, url, heartbeatAt };
}

function createFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    calls.push(input);
    const next = responses.shift() ?? { status: 500 };
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

test('the dashboard assigns guilds to shards with the formula the bot uses', () => {
  assert.equal(shardForGuild(SHARD_0_GUILD, 2), 0);
  assert.equal(shardForGuild(SHARD_1_GUILD, 2), 1);
  assert.equal(shardForGuild(SHARD_1_GUILD, 4), Number((BigInt(SHARD_1_GUILD) >> 22n) % 4n));
  assert.equal(shardForGuild('not-a-snowflake', 2), 0);
  assert.equal(shardForGuild(SHARD_1_GUILD, 1), 0);
});

test('an empty or single shard directory falls back to the bootstrap address', () => {
  assert.deepEqual([...buildShardDirectorySnapshot(null, BOOTSTRAP).endpoints], [[0, BOOTSTRAP]]);
  assert.deepEqual([...buildShardDirectorySnapshot({ shards: [] }, BOOTSTRAP).endpoints], [[0, BOOTSTRAP]]);
  const single = buildShardDirectorySnapshot({ shards: [entry(0, 1, 'http://127.0.0.1:9092')] }, BOOTSTRAP);
  assert.equal(single.shardCount, 1);
  assert.deepEqual([...single.endpoints], [[0, BOOTSTRAP]], 'a single shard is reached the way the dashboard is configured');
});

test('the newest shard count wins while a bot moves from one to two shards', () => {
  const snapshot = buildShardDirectorySnapshot({
    shards: [
      entry(0, 1, 'http://old:9092', '2026-10-18T11:59:00.000Z'),
      entry(0, 2, 'http://app:9092', '2026-10-18T12:00:00.000Z'),
      entry(1, 2, 'http://app-shard-1:9092/', '2026-10-18T12:00:01.000Z'),
      { shardId: 3, shardCount: 2, url: 'http://broken:9092', heartbeatAt: '2026-10-18T12:00:02.000Z' },
      { shardId: 1, shardCount: 2, url: 'not-a-url', heartbeatAt: '2026-10-18T12:00:02.000Z' },
    ],
  }, BOOTSTRAP);

  assert.equal(snapshot.shardCount, 2);
  assert.deepEqual([...snapshot.endpoints], [[0, 'http://app:9092'], [1, 'http://app-shard-1:9092']]);
});

test('guild lookups use the directory and cache it between requests', async () => {
  const { fetchImpl, calls } = createFetch([{
    status: 200,
    body: { shards: [entry(0, 2, 'http://app:9092'), entry(1, 2, 'http://app-shard-1:9092')] },
  }]);
  let now = 0;
  const directory = new ShardDirectory({ bootstrapUrl: `${BOOTSTRAP}/`, secret: 'secret', fetchImpl, now: () => now });

  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), 'http://app-shard-1:9092');
  assert.equal(await directory.urlForGuild(SHARD_0_GUILD), 'http://app:9092');
  assert.deepEqual(await directory.allUrls(), ['http://app:9092', 'http://app-shard-1:9092']);
  assert.deepEqual(calls, ['http://app:9092/api/v1/shards'], 'one lookup serves every request within the cache window');

  now = 10_000;
  await directory.snapshot();
  assert.equal(calls.length, 2, 'the directory is refreshed once the cache window has passed');
});

test('a guild whose shard is not registered has no target', async () => {
  const { fetchImpl } = createFetch([{ status: 200, body: { shards: [entry(0, 2, 'http://app:9092')] } }]);
  const directory = new ShardDirectory({ bootstrapUrl: BOOTSTRAP, secret: 'secret', fetchImpl });
  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), null);
});

test('a bot without the directory route is treated as a single shard', async () => {
  const { fetchImpl } = createFetch([{ status: 404 }]);
  const directory = new ShardDirectory({ bootstrapUrl: BOOTSTRAP, secret: 'secret', fetchImpl });
  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), BOOTSTRAP);
});

test('a failing refresh keeps the last known directory instead of routing everything to shard 0', async () => {
  const { fetchImpl } = createFetch([
    { status: 200, body: { shards: [entry(0, 2, 'http://app:9092'), entry(1, 2, 'http://app-shard-1:9092')] } },
    { status: 503 },
    new Error('connect ECONNREFUSED'),
  ]);
  let now = 0;
  const directory = new ShardDirectory({ bootstrapUrl: BOOTSTRAP, secret: 'secret', fetchImpl, now: () => now });

  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), 'http://app-shard-1:9092');
  now = 20_000;
  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), 'http://app-shard-1:9092');
  now = 40_000;
  assert.equal(await directory.urlForGuild(SHARD_1_GUILD), 'http://app-shard-1:9092');
});

test('concurrent lookups share one directory request', async () => {
  const { fetchImpl, calls } = createFetch([{ status: 200, body: { shards: [entry(0, 1, 'http://app:9092')] } }]);
  const directory = new ShardDirectory({ bootstrapUrl: BOOTSTRAP, secret: 'secret', fetchImpl });
  await Promise.all([directory.snapshot(), directory.snapshot(), directory.urlForGuild(SHARD_0_GUILD)]);
  assert.equal(calls.length, 1);
});
