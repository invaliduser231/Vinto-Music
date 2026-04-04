import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicLibraryStore } from '../src/bot/services/musicLibraryStore.ts';

function createNoopCollection() {
  return {
    createIndex() {},
    async findOne() {
      return null;
    },
    async updateOne() {
      return { acknowledged: true };
    },
  };
}

function createFeatureCollection() {
  let doc: Record<string, unknown> | null = null;
  return {
    createIndex() {},
    async findOne(filter: { guildId?: string }) {
      if (!doc || !filter?.guildId || doc.guildId !== filter.guildId) return null;
      return { ...doc };
    },
    async updateOne(
      filter: { guildId?: string },
      update: { $setOnInsert?: Record<string, unknown>; $set?: Record<string, unknown> },
    ) {
      const base = doc && doc.guildId === filter.guildId
        ? { ...doc }
        : { ...(update.$setOnInsert ?? {}), guildId: filter.guildId ?? null };
      doc = {
        ...base,
        ...(update.$set ?? {}),
      };
      return { acknowledged: true };
    },
  };
}

test('guild station presets can be saved, listed and deleted', async () => {
  const store = new MusicLibraryStore({
    guildPlaylistsCollection: createNoopCollection(),
    userFavoritesCollection: createNoopCollection(),
    guildHistoryCollection: createNoopCollection(),
    guildFeaturesCollection: createFeatureCollection() as never,
  });

  const saved = await store.setGuildStation('111111', 'Chill FM', {
    url: 'https://radio.example.com/live',
    description: 'Late-night ambient',
    tags: ['Ambient', 'Chill', 'ambient'],
  }, 'user-1');

  assert.equal(saved.key, 'chill fm');
  assert.equal(saved.name, 'Chill FM');
  assert.equal(saved.url, 'https://radio.example.com/live');
  assert.equal(saved.description, 'Late-night ambient');
  assert.deepEqual(saved.tags, ['ambient', 'chill']);
  assert.equal(saved.updatedBy, 'user-1');

  const listed = await store.listGuildStations('111111');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.name, 'Chill FM');

  const fetched = await store.getGuildStation('111111', 'chill fm');
  assert.ok(fetched);
  assert.equal(fetched?.url, 'https://radio.example.com/live');

  const removed = await store.deleteGuildStation('111111', 'CHILL FM');
  assert.equal(removed, true);
  assert.deepEqual(await store.listGuildStations('111111'), []);
});
