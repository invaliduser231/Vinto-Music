import test from 'node:test';
import assert from 'node:assert/strict';

import { runWeeklyRecapSweep } from '../src/bot/commandRouterOperations.ts';
import { ScrobbleService } from '../src/bot/services/scrobbleService.ts';
import { shardAssignmentFromConfig } from '../src/core/sharding.ts';

const SHARD_0_GUILD = '1474874137937518680';
const SHARD_1_GUILD = '1485394316330348923';

function createRecapRouter(shardId: number, shardCount: number) {
  const inspected: string[] = [];
  const router = {
    config: { shardId, shardCount },
    rest: {
      sendMessage: async () => undefined,
      listCurrentUserGuilds: async () => [{ id: SHARD_0_GUILD }, { id: SHARD_1_GUILD }],
    },
    library: {
      getGuildFeatureConfig: async (guildId: string) => {
        inspected.push(guildId);
        return null;
      },
      getRecapState: async () => null,
      buildGuildRecap: async () => null,
      markRecapSent: async () => undefined,
    },
    helpPaginations: new Map(),
    searchReactionSelections: new Map(),
    voiceStateStore: {},
    sessions: {},
  };
  return { router, inspected };
}

test('the weekly recap sweep only looks at the guilds this shard owns', async () => {
  const shardOne = createRecapRouter(1, 2);
  await runWeeklyRecapSweep(shardOne.router as never);
  assert.deepEqual(shardOne.inspected, [SHARD_1_GUILD]);

  const shardZero = createRecapRouter(0, 2);
  await runWeeklyRecapSweep(shardZero.router as never);
  assert.deepEqual(shardZero.inspected, [SHARD_0_GUILD]);
});

test('an unsharded bot sweeps every guild', async () => {
  const single = createRecapRouter(0, 1);
  await runWeeklyRecapSweep(single.router as never);
  assert.deepEqual(single.inspected, [SHARD_0_GUILD, SHARD_1_GUILD]);
});

function createScrobbler(flushRetries: boolean | undefined) {
  let retryLookups = 0;
  const service = new ScrobbleService({
    client: {} as never,
    accounts: {
      listDueRetries: async () => {
        retryLookups += 1;
        return [];
      },
    } as never,
    voiceStateStore: {} as never,
    ...(flushRetries === undefined ? {} : { flushRetries }),
  });
  return { service, lookups: () => retryLookups };
}

test('only the shard that flushes retries works through the scrobble retry queue', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const primary = createScrobbler(true);
  const secondary = createScrobbler(false);
  primary.service.start();
  secondary.service.start();

  t.mock.timers.tick(5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(primary.lookups(), 1);
  assert.equal(secondary.lookups(), 0);
  primary.service.stop();
  secondary.service.stop();
});

test('retry flushing stays on by default for an unsharded bot', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scrobbler = createScrobbler(undefined);
  scrobbler.service.start();

  t.mock.timers.tick(5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scrobbler.lookups(), 1);
  scrobbler.service.stop();
});

test('a shard assignment read from config falls back to a single shard', () => {
  assert.deepEqual(shardAssignmentFromConfig(null), { shardId: 0, shardCount: 1 });
  assert.deepEqual(shardAssignmentFromConfig({ shardId: 1, shardCount: 2 }), { shardId: 1, shardCount: 2 });
  assert.deepEqual(shardAssignmentFromConfig({ shardId: 5, shardCount: 2 }), { shardId: 1, shardCount: 2 });
  assert.deepEqual(shardAssignmentFromConfig({ shardId: 'x', shardCount: 'y' }), { shardId: 0, shardCount: 1 });
});
