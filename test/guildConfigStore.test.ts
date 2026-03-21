import test from 'node:test';
import assert from 'node:assert/strict';

import { GuildConfigStore } from '../src/bot/services/guildConfigStore.ts';

type GuildSettingsRecord = {
  dedupeEnabled?: boolean;
  stayInVoiceEnabled?: boolean;
  volumePercent?: number;
  voteSkipRatio?: number;
  voteSkipMinVotes?: number;
  djRoleIds?: string[];
};

type GuildConfigRecord = {
  guildId?: string;
  prefix?: string;
  settings?: GuildSettingsRecord;
  [key: string]: unknown;
};

type UpdatePayload = {
  $set?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
};

type UpdateOptions = {
  upsert?: boolean;
};

function createMockCollection() {
  const store = new Map<string, GuildConfigRecord>();

  return {
    async createIndex() {},
    async findOne(filter: { guildId: string }) {
      const key = String(filter.guildId);
      const value = store.get(key);
      return value ? structuredClone(value) : null;
    },
    async updateOne(filter: { guildId: string }, update: UpdatePayload, options: UpdateOptions = {}) {
      const key = String(filter.guildId);
      const existing = store.get(key) ?? null;

      let next: GuildConfigRecord;
      if (!existing) {
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        next = {
          ...(update.$setOnInsert ?? {}),
        };
      } else {
        next = { ...existing };
      }

      if (update.$set) {
        for (const [field, value] of Object.entries(update.$set)) {
          next[field] = value;
        }
      }

      store.set(key, structuredClone(next));
      return {
        matchedCount: existing ? 1 : 0,
        modifiedCount: 1,
        upsertedCount: existing ? 0 : 1,
      };
    },
  };
}

function buildStore() {
  return new GuildConfigStore({
    collection: createMockCollection(),
    defaults: {
      prefix: '!',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 2,
        djRoleIds: [],
      },
    },
    cacheTtlMs: 60_000,
    maxCacheSize: 100,
  });
}

test('guild config store returns defaults for missing guild', async () => {
  const store = buildStore();
  await store.init();

  const cfg = await store.get('guild-1');
  assert.equal(cfg.guildId, 'guild-1');
  assert.equal(cfg.prefix, '!');
  assert.equal(cfg.settings.volumePercent, 100);
  assert.deepEqual(cfg.settings.djRoleIds, []);
});

test('guild config store persists and normalizes settings updates', async () => {
  const store = buildStore();
  await store.init();

  const updated = await store.update('guild-1', {
    prefix: '>>',
    settings: {
      dedupeEnabled: true,
      stayInVoiceEnabled: true,
      volumePercent: 35,
      voteSkipRatio: 0.75,
      voteSkipMinVotes: 3,
      djRoleIds: ['300', '200', '200', 'x', '1000000'],
    },
  });

  assert.equal(updated.prefix, '>>');
  assert.equal(updated.settings.dedupeEnabled, true);
  assert.equal(updated.settings.stayInVoiceEnabled, true);
  assert.equal(updated.settings.volumePercent, 35);
  assert.equal(updated.settings.voteSkipRatio, 0.75);
  assert.equal(updated.settings.voteSkipMinVotes, 3);
  assert.deepEqual(updated.settings.djRoleIds, ['1000000']);

  const loaded = await store.get('guild-1');
  assert.equal(loaded.prefix, '>>');
  assert.equal(loaded.settings.volumePercent, 35);
  assert.deepEqual(loaded.settings.djRoleIds, ['1000000']);
});

test('guild config store validates invalid vote-skip ratio', async () => {
  const store = buildStore();
  await store.init();

  await assert.rejects(
    () => store.update('guild-1', { settings: { voteSkipRatio: 1.2 } }),
    /between 0 and 1/
  );
});

test('guild config store validates invalid volume percent', async () => {
  const store = buildStore();
  await store.init();

  await assert.rejects(
    () => store.update('guild-1', { settings: { volumePercent: 250 } }),
    /between 0 and 200/
  );
});





