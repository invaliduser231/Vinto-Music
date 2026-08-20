import test from 'node:test';
import assert from 'node:assert/strict';

import { EarrapeProfileStore } from '../src/bot/services/earrapeProfileStore.ts';

type ProfileDoc = {
  guildId: string;
  userId: string;
  offenseScore?: number;
  offenseEvents?: number[];
  offenseEventCount?: number;
  lastOffenseAtMs?: number | null;
  calmRmsBaseline?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function createCollection() {
  const docs = new Map<string, ProfileDoc>();
  const keyOf = (guildId: string, userId: string) => `${guildId}:${userId}`;

  return {
    docs,
    async createIndex() {},
    async findOne(query: { guildId: string; userId: string }) {
      const key = keyOf(query.guildId, query.userId);
      const doc = docs.get(key);
      return doc ? { ...doc } : null;
    },
    async updateOne(
      query: { guildId: string; userId: string },
      update: Record<string, unknown>,
      options: { upsert?: boolean } = {}
    ) {
      const key = keyOf(query.guildId, query.userId);
      const existing = docs.get(key) ?? null;
      if (!existing && options.upsert !== true) return;
      const setOnInsert = (update.$setOnInsert as Record<string, unknown> | undefined) ?? {};
      const set = (update.$set as Record<string, unknown> | undefined) ?? {};
      const next: ProfileDoc = {
        ...(existing ?? {}),
        ...(existing ? {} : setOnInsert as ProfileDoc),
        ...set as ProfileDoc,
      };
      docs.set(key, next);
    },
  };
}

test('earrape profile store decays offense score over time', async () => {
  const collection = createCollection();
  const store = new EarrapeProfileStore({ collection, logger: null });
  await store.init();

  const triggered = await store.updateProfile('guild-1', 'user-1', { offenseDetected: true }, 1_000);
  assert.equal(triggered.offenseScore, 1);
  assert.equal(triggered.offenseEventCount, 1);

  const afterHalfLife = await store.getProfile('guild-1', 'user-1', 1_000 + (6 * 60 * 60 * 1000));
  assert.ok(afterHalfLife.offenseScore < 0.55);
  assert.ok(afterHalfLife.offenseScore > 0.45);
});

test('earrape profile store smooths calm baseline and ignores loud samples', async () => {
  const collection = createCollection();
  const store = new EarrapeProfileStore({ collection, logger: null });
  await store.init();

  const first = await store.updateProfile('guild-2', 'user-2', { calmRmsSample: 0.1 }, 10_000);
  assert.equal(first.calmRmsBaseline, 0.1);

  const second = await store.updateProfile('guild-2', 'user-2', { calmRmsSample: 0.2 }, 10_020);
  assert.ok((second.calmRmsBaseline ?? 0) > 0.1);
  assert.ok((second.calmRmsBaseline ?? 1) < 0.2);

  const ignored = await store.updateProfile('guild-2', 'user-2', { calmRmsSample: 0.8 }, 10_040);
  assert.equal(ignored.calmRmsBaseline, second.calmRmsBaseline);
});

