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

function createUserFavoritesCollection() {
  let doc: Record<string, unknown> | null = null;
  return {
    createIndex() {},
    async findOne(filter: { userId?: string }) {
      if (!doc || !filter?.userId || doc.userId !== filter.userId) return null;
      return JSON.parse(JSON.stringify(doc));
    },
    async updateOne(
      filter: { userId?: string },
      update: { $setOnInsert?: Record<string, unknown>; $set?: Record<string, unknown>; $push?: Record<string, unknown> },
    ) {
      const base = doc && doc.userId === filter.userId
        ? { ...doc }
        : {
            ...(update.$setOnInsert ?? {}),
            userId: filter.userId ?? null,
            tracks: [],
          };
      const next = {
        ...base,
        ...(update.$set ?? {}),
      };
      if (update.$push?.tracks) {
        const tracks = Array.isArray(next.tracks) ? [...next.tracks] : [];
        tracks.push(update.$push.tracks);
        next.tracks = tracks;
      }
      doc = next;
      return { acknowledged: true };
    },
  };
}

test('favorite aliases can be renamed and resolved case-insensitively', async () => {
  const store = new MusicLibraryStore({
    guildPlaylistsCollection: createNoopCollection(),
    userFavoritesCollection: createUserFavoritesCollection() as never,
    guildHistoryCollection: createNoopCollection(),
  });

  await store.addUserFavorite('123456', {
    title: 'Track One',
    url: 'https://example.com/track-1',
    duration: '3:00',
    source: 'youtube',
  });

  const renamed = await store.renameUserFavorite('123456', 1, 'Roadtrip Mix');
  assert.ok(renamed);
  assert.equal(renamed?.alias, 'Roadtrip Mix');
  assert.equal(renamed?.aliasKey, 'roadtrip mix');

  const found = await store.getUserFavoriteByAlias('123456', 'roadTRIP MIX');
  assert.ok(found);
  assert.equal(found?.url, 'https://example.com/track-1');
  assert.equal(found?.alias, 'Roadtrip Mix');
});

test('favorite aliases enforce uniqueness per user', async () => {
  const store = new MusicLibraryStore({
    guildPlaylistsCollection: createNoopCollection(),
    userFavoritesCollection: createUserFavoritesCollection() as never,
    guildHistoryCollection: createNoopCollection(),
  });

  await store.addUserFavorite('123456', {
    title: 'Track One',
    url: 'https://example.com/track-1',
    duration: '3:00',
    source: 'youtube',
  });
  await store.addUserFavorite('123456', {
    title: 'Track Two',
    url: 'https://example.com/track-2',
    duration: '3:30',
    source: 'youtube',
  });

  await store.renameUserFavorite('123456', 1, 'Roadtrip Mix');
  await assert.rejects(
    async () => store.renameUserFavorite('123456', 2, 'roadtrip mix'),
    /Alias already exists in your favorites\./
  );
});
