import test from 'node:test';
import assert from 'node:assert/strict';

import { CROWN_MIN_PLAYS, LastFmCrownStore } from '../src/bot/services/lastFmCrownStore.ts';

type Doc = Record<string, unknown>;

function createCollection() {
  const docs: Doc[] = [];
  const matches = (doc: Doc, filter: Doc) => Object.entries(filter).every(([key, value]) => doc[key] === value);
  return {
    docs,
    async findOne(filter: Doc) {
      const found = docs.find((doc) => matches(doc, filter));
      return (found ? { ...found } : null) as never;
    },
    async updateOne(filter: Doc, update: { $set: Doc }) {
      const existing = docs.find((doc) => matches(doc, filter));
      if (existing) Object.assign(existing, update.$set);
      else docs.push({ ...update.$set });
    },
    find(filter: Doc) {
      let result = docs.filter((doc) => matches(doc, filter));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const [[key, direction]] = Object.entries(spec) as [[string, 1 | -1]];
          result = [...result].sort((a, b) => (Number(a[key]) - Number(b[key])) * direction);
          return cursor;
        },
        limit(count: number) {
          result = result.slice(0, count);
          return cursor;
        },
        async toArray() {
          return result as never[];
        },
      };
      return cursor;
    },
    async countDocuments(filter: Doc) {
      return docs.filter((doc) => matches(doc, filter)).length;
    },
  };
}

const GUILD = '1000001';

test('the first holder above the threshold claims the crown', async () => {
  const store = new LastFmCrownStore({ collection: createCollection() });

  const outcome = await store.record(GUILD, 'M83', { userId: '2000001', username: 'a', playcount: CROWN_MIN_PLAYS });
  assert.equal(outcome.status, 'claimed');
});

test('no crown is handed out below the threshold', async () => {
  const store = new LastFmCrownStore({ collection: createCollection() });

  const outcome = await store.record(GUILD, 'M83', { userId: '2000001', username: 'a', playcount: CROWN_MIN_PLAYS - 1 });
  assert.equal(outcome.status, 'none');
  assert.equal(await store.get(GUILD, 'M83'), null);
});

test('a new leader steals the crown and keeps the claim date on refresh', async () => {
  const store = new LastFmCrownStore({ collection: createCollection() });
  const claimedAt = new Date('2026-10-01T00:00:00Z');

  await store.record(GUILD, 'M83', { userId: '2000001', username: 'a', playcount: 50 }, claimedAt);
  const stolen = await store.record(GUILD, 'm83', { userId: '2000002', username: 'b', playcount: 80 });
  assert.equal(stolen.status, 'stolen');
  assert.equal(stolen.status === 'stolen' ? stolen.previousUserId : null, '2000001');

  const refreshedAt = new Date('2026-10-05T00:00:00Z');
  const firstClaim = (await store.get(GUILD, 'M83'))!.claimedAt;
  const kept = await store.record(GUILD, 'M83', { userId: '2000002', username: 'b', playcount: 90 }, refreshedAt);
  assert.equal(kept.status, 'kept');
  assert.equal(kept.status === 'kept' ? kept.crown.claimedAt : null, firstClaim);
});

test('crowns are listed per member by playcount', async () => {
  const store = new LastFmCrownStore({ collection: createCollection() });
  await store.record(GUILD, 'M83', { userId: '2000001', username: 'a', playcount: 40 });
  await store.record(GUILD, 'Air', { userId: '2000001', username: 'a', playcount: 90 });
  await store.record(GUILD, 'Justice', { userId: '2000002', username: 'b', playcount: 60 });

  const crowns = await store.listForUser(GUILD, '2000001');
  assert.deepEqual(crowns.map((crown) => crown.artist), ['Air', 'M83']);
  assert.equal(await store.countForUser(GUILD, '2000001'), 2);
});
