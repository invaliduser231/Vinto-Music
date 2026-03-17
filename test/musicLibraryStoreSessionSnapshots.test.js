import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicLibraryStore } from '../src/bot/services/musicLibraryStore.js';

function createNoopCollection() {
  return {
    createIndex() {},
    findOne() {
      return null;
    },
    updateOne() {},
  };
}

test('upsertSessionSnapshot does not duplicate identifier fields into $set', async () => {
  const calls = [];
  const snapshotCollection = {
    async updateOne(filter, update, options) {
      calls.push({ filter, update, options });
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

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filter, {
    guildId: '111111',
    voiceChannelId: '222222',
  });
  assert.equal(calls[0].options?.upsert, true);
  assert.equal(calls[0].update.$setOnInsert.guildId, '111111');
  assert.equal(calls[0].update.$setOnInsert.voiceChannelId, '222222');
  assert.equal('guildId' in calls[0].update.$set, false);
  assert.equal('voiceChannelId' in calls[0].update.$set, false);
  assert.equal('createdAt' in calls[0].update.$set, false);
  assert.equal('updatedAt' in calls[0].update.$set, true);
  assert.deepEqual(result, {
    guildId: '111111',
    voiceChannelId: '222222',
    state: { playing: true },
  });
});
