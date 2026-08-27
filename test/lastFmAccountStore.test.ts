import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { LastFmAccountStore } from '../src/bot/services/lastFmAccountStore.ts';

type Doc = Record<string, unknown>;

function applyUpdate(target: Doc, update: Doc): Doc {
  const next = { ...target };

  for (const [field, value] of Object.entries((update.$set ?? {}) as Doc)) {
    next[field] = value;
  }
  for (const [field, value] of Object.entries((update.$inc ?? {}) as Doc)) {
    next[field] = Number(next[field] ?? 0) + Number(value);
  }

  return next;
}

function readPath(doc: Doc, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (current, segment) => (current && typeof current === 'object' ? (current as Doc)[segment] : undefined),
    doc,
  );
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = readPath(doc, field);

    if (expected && typeof expected === 'object' && '$in' in (expected as Doc)) {
      return ((expected as { $in: unknown[] }).$in).includes(actual);
    }
    if (expected && typeof expected === 'object' && '$gt' in (expected as Doc)) {
      return Number(actual ?? 0) > Number((expected as { $gt: number }).$gt);
    }
    if (expected && typeof expected === 'object' && '$lte' in (expected as Doc)) {
      return Number(actual ?? 0) <= Number((expected as { $lte: Date }).$lte);
    }
    return actual === expected;
  });
}

function createCollection() {
  const docs: Doc[] = [];

  return {
    docs,
    async createIndex() {},
    async findOne(filter: Doc) {
      return docs.find((doc) => matches(doc, filter)) ?? null;
    },
    async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index < 0) {
        if (!options.upsert) return { matchedCount: 0 };
        docs.push(applyUpdate({ ...(update.$setOnInsert ?? {}) } as Doc, update));
        return { upsertedCount: 1 };
      }

      docs[index] = applyUpdate(docs[index] as Doc, update);
      return { modifiedCount: 1 };
    },
    async deleteOne(filter: Doc) {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index < 0) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter: Doc) {
      let deleted = 0;
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (matches(docs[index] as Doc, filter)) {
          docs.splice(index, 1);
          deleted += 1;
        }
      }
      return { deletedCount: deleted };
    },
    async insertOne(doc: Doc) {
      docs.push({ ...doc });
      return { insertedId: docs.length };
    },
    async countDocuments() {
      return docs.length;
    },
    find(filter: Doc) {
      let selected = docs.filter((doc) => matches(doc, filter));
      return {
        sort(spec: Record<string, 1 | -1>) {
          const [field, direction] = Object.entries(spec)[0] ?? ['', 1];
          selected = [...selected].sort((left, right) => {
            const a = Number(left[field] ?? 0);
            const b = Number(right[field] ?? 0);
            return direction === -1 ? b - a : a - b;
          });
          return this;
        },
        limit(count: number) {
          selected = selected.slice(0, count);
          return this;
        },
        async toArray() {
          return selected.map((doc) => ({ ...doc }));
        },
      };
    },
  };
}

function createStore() {
  const collection = createCollection();
  const retryCollection = createCollection();
  const store = new LastFmAccountStore({
    collection: collection as never,
    retryCollection: retryCollection as never,
    encryptionKey: randomBytes(32),
    cacheTtlMs: 0,
  });

  return { store, collection, retryCollection };
}

test('linking stores an encrypted session key that reads back', async () => {
  const { store, collection } = createStore();

  const account = await store.link('123456789', 'listener', 'plain-session-key');

  assert.equal(account?.username, 'listener');
  assert.equal(account?.scrobblingEnabled, true);
  assert.equal(account?.scrobbleCount, 0);

  const stored = collection.docs[0] as { sessionKey?: { data?: string } };
  assert.ok(stored.sessionKey?.data);
  assert.notEqual(stored.sessionKey?.data, 'plain-session-key');
  assert.equal(await store.getSessionKey('123456789'), 'plain-session-key');
});

test('an account without a session key is treated as not linked', async () => {
  const { store, collection } = createStore();
  collection.docs.push({ userId: '123456789', username: 'listener' });

  assert.equal(await store.get('123456789'), null);
});

test('invalid user ids never reach the collection', async () => {
  const { store } = createStore();

  assert.equal(await store.get('nope'), null);
  assert.equal(await store.link('nope', 'listener', 'key'), null);
  assert.equal(await store.unlink('nope'), false);
});

test('unlinking drops the account and its queued retries', async () => {
  const { store, retryCollection } = createStore();
  await store.link('123456789', 'listener', 'key');
  await store.queueRetry('123456789', { artist: 'a', track: 'b', timestamp: 1 });

  assert.equal(retryCollection.docs.length, 1);
  assert.equal(await store.unlink('123456789'), true);
  assert.equal(await store.get('123456789'), null);
  assert.equal(retryCollection.docs.length, 0);
});

test('scrobbling on consecutive days extends the streak', async () => {
  const { store } = createStore();
  await store.link('123456789', 'listener', 'key');

  const first = await store.recordScrobble('123456789', new Date('2026-03-01T20:00:00.000Z'));
  assert.equal(first?.scrobbleCount, 1);
  assert.equal(first?.streakDays, 1);

  const sameDay = await store.recordScrobble('123456789', new Date('2026-03-01T22:00:00.000Z'));
  assert.equal(sameDay?.scrobbleCount, 2);
  assert.equal(sameDay?.streakDays, 1);
  assert.equal(sameDay?.streakExtended, false);

  const nextDay = await store.recordScrobble('123456789', new Date('2026-03-02T09:00:00.000Z'));
  assert.equal(nextDay?.scrobbleCount, 3);
  assert.equal(nextDay?.streakDays, 2);
  assert.equal(nextDay?.streakExtended, true);
});

test('a gap resets the streak back to one', async () => {
  const { store } = createStore();
  await store.link('123456789', 'listener', 'key');

  await store.recordScrobble('123456789', new Date('2026-03-01T20:00:00.000Z'));
  const afterGap = await store.recordScrobble('123456789', new Date('2026-03-05T20:00:00.000Z'));

  assert.equal(afterGap?.streakDays, 1);
});

test('the leaderboard sorts by scrobbles and can be limited to a member list', async () => {
  const { store } = createStore();
  await store.link('111111111', 'alpha', 'key');
  await store.link('222222222', 'beta', 'key');
  await store.link('333333333', 'gamma', 'key');

  await store.recordScrobble('111111111', new Date('2026-03-01T10:00:00.000Z'));
  for (let index = 0; index < 3; index += 1) {
    await store.recordScrobble('222222222', new Date('2026-03-01T10:00:00.000Z'));
  }

  const global = await store.listTop(10);
  assert.deepEqual(global.map((entry) => entry.username), ['beta', 'alpha']);

  const scoped = await store.listTop(10, ['111111111']);
  assert.deepEqual(scoped.map((entry) => entry.username), ['alpha']);

  assert.deepEqual(await store.listTop(10, []), []);
});

test('failed scrobbles are retried and dropped once they succeed', async () => {
  const { store, retryCollection } = createStore();
  await store.link('123456789', 'listener', 'key');
  await store.queueRetry('123456789', { artist: 'a', track: 'b', timestamp: 1 });

  retryCollection.docs[0]!.nextAttemptAt = new Date(Date.now() - 1_000);
  const due = await store.listDueRetries();
  assert.equal(due.length, 1);

  await store.resolveRetry(due[0]!, false);
  assert.equal(retryCollection.docs.length, 1);
  assert.equal(retryCollection.docs[0]?.attempts, 1);

  await store.resolveRetry(due[0]!, true);
  assert.equal(retryCollection.docs.length, 0);
});

test('a retry is dropped after too many attempts', async () => {
  const { store, retryCollection } = createStore();
  await store.link('123456789', 'listener', 'key');
  await store.queueRetry('123456789', { artist: 'a', track: 'b', timestamp: 1 });

  const exhausted = { ...(retryCollection.docs[0] as Doc), attempts: 4 };
  await store.resolveRetry(exhausted as never, false);
  assert.equal(retryCollection.docs.length, 0);
});

test('pausing scrobbling keeps the account linked', async () => {
  const { store } = createStore();
  await store.link('123456789', 'listener', 'key');

  const paused = await store.setScrobblingEnabled('123456789', false);
  assert.equal(paused?.scrobblingEnabled, false);
  assert.equal(await store.getSessionKey('123456789'), 'key');
});
