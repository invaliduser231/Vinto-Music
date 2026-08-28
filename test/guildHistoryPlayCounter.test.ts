import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicLibraryStore } from '../src/bot/services/musicLibraryStore.ts';

type Doc = Record<string, unknown>;

function createHistoryCollection(docs: Doc[] = []) {
  return {
    docs,
    seeded: [] as unknown[],
    async createIndex() {},
    async findOne(filter: Doc) {
      return docs.find((doc) => doc.guildId === filter.guildId) ?? null;
    },
    async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
      let doc = docs.find((entry) => entry.guildId === filter.guildId);
      if (!doc) {
        if (!options.upsert) return { matchedCount: 0 };
        doc = { ...(update.$setOnInsert as Doc ?? {}) };
        docs.push(doc);
      }

      for (const [field, value] of Object.entries((update.$set ?? {}) as Doc)) doc[field] = value;
      for (const [field, value] of Object.entries((update.$inc ?? {}) as Doc)) {
        doc[field] = Number(doc[field] ?? 0) + Number(value);
      }

      const push = (update.$push ?? {}) as Record<string, { $each: unknown[]; $slice: number }>;
      for (const [field, spec] of Object.entries(push)) {
        const list = Array.isArray(doc[field]) ? doc[field] as unknown[] : [];
        list.push(...spec.$each);
        doc[field] = spec.$slice < 0 ? list.slice(spec.$slice) : list;
      }

      return { modifiedCount: 1 };
    },
    async updateMany(filter: Doc, update: unknown) {
      this.seeded.push({ filter, update });
      for (const doc of docs) {
        if (filter.totalPlays && doc.totalPlays !== undefined) continue;
        doc.totalPlays = Array.isArray(doc.tracks) ? (doc.tracks as unknown[]).length : 0;
      }
      return { modifiedCount: docs.length };
    },
    aggregate() {
      const total = docs.reduce((sum, doc) => sum + Number(doc.totalPlays ?? 0), 0);
      return { async toArray() { return [{ _id: null, total }]; } };
    },
  };
}

function createStore(historyDocs: Doc[] = [], maxHistoryTracks = 3) {
  const guildHistory = createHistoryCollection(historyDocs);
  const empty = {
    async createIndex() {},
    async findOne() { return null; },
    async updateOne() { return {}; },
  };

  const store = new MusicLibraryStore({
    guildPlaylistsCollection: empty as never,
    userFavoritesCollection: empty as never,
    guildHistoryCollection: guildHistory as never,
    maxHistoryTracks,
  });

  return { store, guildHistory };
}

const TRACK = { title: 'Glatteis', url: 'https://example.com/1', duration: '3:22', source: 'deezer' };

test('every appended track increments a counter that trimming cannot touch', async () => {
  const { store, guildHistory } = createStore([], 3);

  for (let index = 0; index < 7; index += 1) {
    await store.appendGuildHistory('1474874137937518680', { ...TRACK, url: `https://example.com/${index}` });
  }

  const doc = guildHistory.docs[0] as { tracks: unknown[]; totalPlays: number };
  assert.equal(doc.tracks.length, 3, 'history itself stays capped');
  assert.equal(doc.totalPlays, 7, 'the counter keeps the full number');
  assert.equal(await store.getTotalPlays(), 7);
});

test('existing guilds start from the history they still have', async () => {
  const { store, guildHistory } = createStore([
    { guildId: '1', tracks: [{}, {}, {}, {}] },
    { guildId: '2', tracks: [] },
  ]);

  await store.init();

  assert.equal(guildHistory.docs[0]?.totalPlays, 4);
  assert.equal(guildHistory.docs[1]?.totalPlays, 0);
  assert.equal(await store.getTotalPlays(), 4);
});

test('the seeding only touches documents without a counter', async () => {
  const { store, guildHistory } = createStore([{ guildId: '1', tracks: [{}, {}], totalPlays: 91 }]);

  await store.init();

  const call = guildHistory.seeded[0] as { filter: Record<string, unknown> };
  assert.deepEqual(call.filter, { totalPlays: { $exists: false } });
  assert.equal(guildHistory.docs[0]?.totalPlays, 91, 'an existing counter is left alone');
});

test('the total is zero when nothing was ever counted', async () => {
  const { store } = createStore([]);
  assert.equal(await store.getTotalPlays(), 0);
});
