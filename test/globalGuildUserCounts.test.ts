import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchGlobalGuildAndUserCounts } from '../src/bot/commands/commandHelpers.ts';

function buildMembers(startId: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    user: {
      id: String(startId + index),
    },
  }));
}

test('fetchGlobalGuildAndUserCounts uses guild member pagination for exact counts', async () => {
  const detailCalls: string[] = [];
  const rest = {
    async listCurrentUserGuilds() {
      return [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ];
    },
    async listGuildMembers(guildId: string, options: { after?: string | null }) {
      if (guildId === '1') {
        if (options.after == null) return buildMembers(1, 1_000);
        if (options.after === '1000') return buildMembers(1001, 2);
      }

      if (guildId === '2') {
        if (options.after == null) return buildMembers(2001, 3);
      }

      return [];
    },
    async getGuild(guildId: string) {
      detailCalls.push(guildId);
      return { id: guildId, member_count: 999999 };
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);
  assert.deepEqual(result, {
    guildCount: 2,
    userCount: 1005,
    incompleteGuildCount: 0,
  });
  assert.deepEqual(detailCalls, []);
});

test('fetchGlobalGuildAndUserCounts sums member_count from guild details', async () => {
  const detailCalls: Array<{ guildId: string; options: { withCounts: true } }> = [];
  const rest = {
    async listCurrentUserGuilds() {
      return [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ];
    },
    async getGuild(guildId: string, options: { withCounts: true }) {
      detailCalls.push({ guildId, options });
      if (guildId === '1') return { id: '1', member_count: 17 };
      if (guildId === '2') return { id: '2', member_count: 23 };
      return null;
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);
  assert.deepEqual(result, {
    guildCount: 2,
    userCount: 40,
    incompleteGuildCount: 0,
  });
  assert.deepEqual(detailCalls, [
    { guildId: '1', options: { withCounts: true } },
    { guildId: '2', options: { withCounts: true } },
  ]);
});

test('fetchGlobalGuildAndUserCounts falls back to getGuild and list payload if member listing fails', async () => {
  const rest = {
    async listCurrentUserGuilds() {
      return [
        { id: '10', member_count: 9 },
        { id: '20', member_count: 5 },
      ];
    },
    async listGuildMembers() {
      throw new Error('temporary list failure');
    },
    async getGuild(guildId: string) {
      if (guildId === '10') return { id: guildId, member_count: 12 };
      return null;
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);
  assert.deepEqual(result, {
    guildCount: 2,
    userCount: 17,
    incompleteGuildCount: 0,
  });
});

test('fetchGlobalGuildAndUserCounts falls back to list payload count when detail call fails', async () => {
  const rest = {
    async listCurrentUserGuilds() {
      return [
        { id: '10', member_count: 5 },
        { id: '20', approximateMemberCount: 7 },
      ];
    },
    async getGuild(guildId: string) {
      if (guildId === '10') {
        throw new Error('temporary error');
      }
      return null;
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);
  assert.deepEqual(result, {
    guildCount: 2,
    userCount: 12,
    incompleteGuildCount: 0,
  });
});

test('fetchGlobalGuildAndUserCounts marks guild as incomplete when no count is available', async () => {
  const rest = {
    async listCurrentUserGuilds() {
      return [{ id: '42', name: 'NoCountGuild' }];
    },
    async getGuild() {
      return { id: '42', stats: {} };
    },
  };

  const result = await fetchGlobalGuildAndUserCounts(rest);
  assert.deepEqual(result, {
    guildCount: 1,
    userCount: 0,
    incompleteGuildCount: 1,
  });
});





