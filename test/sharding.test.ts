import test from 'node:test';
import assert from 'node:assert/strict';

import { guildBelongsToShard, parseShardAssignment, shardForGuild } from '../src/core/sharding.ts';

test('a single shard owns every guild', () => {
  const single = { shardId: 0, shardCount: 1 };
  for (const guildId of ['1485394316330348923', '1541587443302535168', '0']) {
    assert.equal(guildBelongsToShard(guildId, single), true);
  }
});

test('every guild lands on exactly one shard', () => {
  const shardCount = 4;
  const guildIds = [
    '1485394316330348923',
    '1541587443302535168',
    '1474874137937518680',
    '1473874611065868398',
    '1544041577016463360',
    '1548923343938256896',
  ];

  for (const guildId of guildIds) {
    const owners = [0, 1, 2, 3].filter((shardId) => guildBelongsToShard(guildId, { shardId, shardCount }));
    assert.equal(owners.length, 1, `${guildId} must belong to one shard, got ${owners.length}`);
  }
});

test('the assignment follows the documented snowflake formula', () => {
  const guildId = '1485394316330348923';
  const expected = Number((BigInt(guildId) >> 22n) % 4n);
  assert.equal(shardForGuild(guildId, 4), expected);
});

test('a load of guilds spreads across the shards instead of piling onto one', () => {
  const shardCount = 4;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 4_000; i += 1) {
    const guildId = String(1_400_000_000_000_000_000n + BigInt(i) * 4_194_304n);
    const owner = shardForGuild(guildId, shardCount);
    if (owner != null) counts[owner] = (counts[owner] ?? 0) + 1;
  }
  for (const count of counts) {
    assert.ok(count > 0, `every shard has to get work, got ${counts.join('/')}`);
  }
});

test('a guild id that is not a snowflake stays with the shard asking', () => {
  assert.equal(shardForGuild('not-a-number', 4), null);
  assert.equal(guildBelongsToShard('not-a-number', { shardId: 2, shardCount: 4 }), true);
});

test('the configuration rejects an impossible assignment', () => {
  assert.deepEqual(parseShardAssignment(undefined, undefined), { shardId: 0, shardCount: 1 });
  assert.deepEqual(parseShardAssignment('1', '2'), { shardId: 1, shardCount: 2 });
  assert.throws(() => parseShardAssignment('2', '2'), /lower than SHARD_COUNT/);
  assert.throws(() => parseShardAssignment('0', '0'), /positive integer/);
  assert.throws(() => parseShardAssignment('-1', '2'), /zero or a positive integer/);
});
