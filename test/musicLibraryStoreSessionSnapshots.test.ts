import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicLibraryStore } from '../src/bot/services/musicLibraryStore.ts';

type SnapshotCall = {
  filter: { guildId: string; voiceChannelId: string };
  update: {
    $set: Record<string, unknown>;
    $setOnInsert: Record<string, unknown>;
  };
  options?: { upsert?: boolean };
};

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

function first<T>(values: T[]): T {
  return values[0]!;
}

test('upsertSessionSnapshot does not duplicate identifier fields into $set', async () => {
  const calls: SnapshotCall[] = [];
  const snapshotCollection = {
    async updateOne(filter: SnapshotCall['filter'], update: SnapshotCall['update'], options?: SnapshotCall['options']) {
      calls.push(options ? { filter, update, options } : { filter, update });
      return { acknowledged: true };
    },
    async findOne() {
      return {
        guildId: '111111',
        voiceChannelId: '222222',
        state: { playing: true },
      };
    },
  };

  const store = new MusicLibraryStore({
    guildPlaylistsCollection: createNoopCollection(),
    userFavoritesCollection: createNoopCollection(),
    guildHistoryCollection: createNoopCollection(),
    guildFeaturesCollection: createNoopCollection(),
    guildSessionSnapshotsCollection: snapshotCollection,
  });

  const result = await store.upsertSessionSnapshot('111111', '222222', {
    guildId: '111111',
    voiceChannelId: '222222',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    state: { playing: true },
    currentTrack: {
      title: 'Demo',
      url: 'https://example.com/demo',
      source: 'radio-stream',
    },
  });

  const call = first(calls);
  assert.equal(calls.length, 1);
  assert.deepEqual(call.filter, {
    guildId: '111111',
    voiceChannelId: '222222',
  });
  assert.equal(call.options?.upsert, true);
  assert.equal(call.update.$setOnInsert.guildId, '111111');
  assert.equal(call.update.$setOnInsert.voiceChannelId, '222222');
  assert.equal('guildId' in call.update.$set, false);
  assert.equal('voiceChannelId' in call.update.$set, false);
  assert.equal('createdAt' in call.update.$set, false);
  assert.equal('updatedAt' in call.update.$set, true);
  assert.deepEqual(result, {
    guildId: '111111',
    voiceChannelId: '222222',
    state: { playing: true },
  });
});





