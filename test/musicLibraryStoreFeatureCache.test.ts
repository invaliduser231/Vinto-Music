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

function createFeatureCollection(doc: Record<string, unknown> | null) {
  const counters = { findOne: 0, updateOne: 0 };
  return {
    counters,
    createIndex() {},
    async findOne() {
      counters.findOne += 1;
      return doc;
    },
    async updateOne() {
      counters.updateOne += 1;
      return { acknowledged: true };
    },
  };
}

type FeatureCollectionArg = NonNullable<
  ConstructorParameters<typeof MusicLibraryStore>[0]['guildFeaturesCollection']
>;

function createStore(featureCollection: ReturnType<typeof createFeatureCollection>) {
  return new MusicLibraryStore({
    guildPlaylistsCollection: createNoopCollection(),
    userFavoritesCollection: createNoopCollection(),
    guildHistoryCollection: createNoopCollection(),
    guildFeaturesCollection: featureCollection as unknown as FeatureCollectionArg,
    guildSessionSnapshotsCollection: createNoopCollection(),
  });
}

test('getGuildFeatureConfig serves repeated reads from cache', async () => {
  const features = createFeatureCollection({
    guildId: '111111',
    webhookUrl: 'https://example.com/hook',
  });
  const store = createStore(features);

  const first = await store.getGuildFeatureConfig('111111');
  const second = await store.getGuildFeatureConfig('111111');
  const third = await store.getGuildFeatureConfig('111111');

  assert.equal(features.counters.findOne, 1);
  assert.equal(first.webhookUrl, 'https://example.com/hook');
  assert.equal(second.webhookUrl, 'https://example.com/hook');
  assert.equal(third.webhookUrl, 'https://example.com/hook');
});

test('getGuildFeatureConfig hands out copies so callers cannot poison the cache', async () => {
  const features = createFeatureCollection({
    guildId: '111111',
    stations: [],
  });
  const store = createStore(features);

  const first = await store.getGuildFeatureConfig('111111');
  (first as Record<string, unknown>).webhookUrl = 'https://tampered.example';

  const second = await store.getGuildFeatureConfig('111111');

  assert.notEqual(second.webhookUrl, 'https://tampered.example');
});

test('patchGuildFeatureConfig writes without reading the document back', async () => {
  const features = createFeatureCollection({
    guildId: '111111',
    webhookUrl: null,
  });
  const store = createStore(features);

  await store.getGuildFeatureConfig('111111');
  const readsAfterWarmup = features.counters.findOne;

  const patched = await store.patchGuildFeatureConfig('111111', {
    webhookUrl: 'https://example.com/hook',
  });

  assert.equal(features.counters.updateOne, 1);
  assert.equal(features.counters.findOne, readsAfterWarmup);
  assert.equal(patched.webhookUrl, 'https://example.com/hook');
});

test('patchGuildFeatureConfig refreshes the cache with the merged document', async () => {
  const features = createFeatureCollection({
    guildId: '111111',
    webhookUrl: null,
    recapChannelId: '999',
  });
  const store = createStore(features);

  await store.patchGuildFeatureConfig('111111', {
    webhookUrl: 'https://example.com/hook',
  });
  const after = await store.getGuildFeatureConfig('111111');

  assert.equal(after.webhookUrl, 'https://example.com/hook');
  assert.equal(after.recapChannelId, '999');
});
