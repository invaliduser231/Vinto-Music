import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchGlobalGuildAndUserCounts } from '../src/bot/commands/commandHelpers.ts';

function buildGuilds(startId: number, count: number, memberCount: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(startId + index),
    approximate_member_count: memberCount,
  }));
}

test('fetchGlobalGuildAndUserCounts sums approximate member counts from the guild list', async () => {
  const calls: Array<{ limit: number; after?: string; withCounts?: boolean }> = [];
  const rest = {
    async listCurrentUserGuilds(options: { limit: number; after?: string; withCounts?: boolean }) {
      calls.push(options);
      if (!options.after) return buildGuilds(1, 200, 2);
      if (options.after === '200') return buildGuilds(201, 3, 5);
      return [];
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);

  assert.deepEqual(result, { guildCount: 203, userCount: 415, incompleteGuildCount: 0 });
  assert.deepEqual(calls, [
    { limit: 200, withCounts: true },
    { limit: 200, after: '200', withCounts: true },
  ]);
});

test('fetchGlobalGuildAndUserCounts treats a zero or missing count as unknown', async () => {
  const rest = {
    async listCurrentUserGuilds() {
      return [
        { id: '1', approximate_member_count: 12 },
        { id: '2', approximate_member_count: 0 },
        { id: '3' },
        { id: '4', member_count: 7 },
      ];
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);

  assert.deepEqual(result, { guildCount: 4, userCount: 19, incompleteGuildCount: 2 });
});

test('fetchGlobalGuildAndUserCounts counts a guild once when pages overlap', async () => {
  const rest = {
    async listCurrentUserGuilds(options: { after?: string }) {
      if (!options.after) return [...buildGuilds(1, 199, 1), { id: '199', approximate_member_count: 1 }];
      return [];
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);

  assert.equal(result.guildCount, 199);
});

test('fetchGlobalGuildAndUserCounts lets a failed page reject instead of reporting a partial total', async () => {
  const rest = {
    async listCurrentUserGuilds() {
      throw new Error('temporary failure');
    },
  };

  await assert.rejects(fetchGlobalGuildAndUserCounts(rest), /temporary failure/);
});
