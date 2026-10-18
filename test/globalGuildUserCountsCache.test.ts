import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearGlobalGuildAndUserCountsCache,
  fetchGlobalGuildAndUserCounts,
  fetchGlobalGuildCount,
  getCachedGlobalGuildAndUserCounts,
} from '../src/bot/commands/commandHelpers.ts';

test('fetched totals are cached per rest client and reused for the guild count', async () => {
  clearGlobalGuildAndUserCountsCache();

  let guildListCalls = 0;
  const rest = {
    async listCurrentUserGuilds() {
      guildListCalls += 1;
      return [
        { id: '1', approximate_member_count: 1 },
        { id: '2', approximate_member_count: 2 },
      ];
    },
  };

  const first = await fetchGlobalGuildAndUserCounts(rest);
  const guildCount = await fetchGlobalGuildCount(rest);

  assert.deepEqual(first, { guildCount: 2, userCount: 3, incompleteGuildCount: 0 });
  assert.equal(guildCount, 2);
  assert.equal(guildListCalls, 1);
  assert.deepEqual(getCachedGlobalGuildAndUserCounts(rest), first);
  assert.equal(getCachedGlobalGuildAndUserCounts({}), null);
});

test('fetchGlobalGuildCount lists guilds without asking for member counts', async () => {
  clearGlobalGuildAndUserCountsCache();

  const calls: Array<{ withCounts?: boolean }> = [];
  const rest = {
    async listCurrentUserGuilds(options: { withCounts?: boolean }) {
      calls.push(options);
      return [{ id: '1' }, { id: '2' }, { id: '3' }];
    },
  };

  const guildCount = await fetchGlobalGuildCount(rest);

  assert.equal(guildCount, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.withCounts, undefined);
});
