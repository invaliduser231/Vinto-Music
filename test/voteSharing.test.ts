import test from 'node:test';
import assert from 'node:assert/strict';

import { VoteService } from '../src/bot/services/voteService.ts';
import { MongoVoterStore, type VoterStore, type VoterStoreCollection } from '../src/bot/services/voterStore.ts';
import { loadConfig } from '../src/config.ts';

type Doc = Record<string, unknown>;

function createMemoryStore(initial: string[] = []) {
  const voterIds = [...initial];
  const added: string[][] = [];
  const loads: Array<Date | null> = [];
  const store: VoterStore = {
    load: async (_botId, since) => {
      loads.push(since);
      return { voterIds: [...voterIds], latestSeenAt: new Date('2026-10-18T12:00:00Z') };
    },
    add: async (_botId, ids) => {
      added.push([...ids]);
      voterIds.push(...ids);
    },
  };
  return { store, added, loads, voterIds };
}

function createService(options: Partial<ConstructorParameters<typeof VoteService>[0]> = {}) {
  return new VoteService({ apiBase: 'https://x', apiKey: 'fl_x', botId: '1', pageLimit: 2, ...options });
}

test('a shard that does not poll reads voters from the shared store only', async () => {
  const { store } = createMemoryStore(['10', '11']);
  const service = createService({ pollApi: false, store });
  service._fetchPage = async () => {
    throw new Error('the api must not be called');
  };

  assert.equal(await service.refresh(), true);
  assert.equal(service.hasVoted('11'), true);
  assert.equal(service.ready, true);
});

test('the polling shard restores voters from the store and stops at the first known voter', async () => {
  const { store, added } = createMemoryStore(['3']);
  const service = createService({ pollApi: true, store });
  const requested: number[] = [];
  service._fetchPage = async (page) => {
    requested.push(page);
    const pages: Record<number, string[]> = { 1: ['5', '4'], 2: ['3', '2'], 3: ['1'] };
    return { voterIds: pages[page] ?? [], total: 5 };
  };

  assert.equal(await service.refresh(), true);
  assert.deepEqual(requested, [1, 2]);
  assert.deepEqual(added, [['5', '4', '2']]);
  assert.equal(service.hasVoted('4'), true);
});

test('every poll picks up voters other shards stored since the last sync', async () => {
  const { store, loads, voterIds } = createMemoryStore(['1']);
  const service = createService({ pollApi: true, store });
  service._fetchPage = async () => ({ voterIds: ['1'], total: 1 });

  await service.refresh();
  voterIds.push('7');
  await service.refresh();

  assert.deepEqual(loads, [null, new Date('2026-10-18T12:00:00Z')]);
  assert.equal(service.hasVoted('7'), true);
});

test('a vote check unlocks a fresh voter at once, persists it and respects the cooldown', async () => {
  const { store, added } = createMemoryStore();
  const service = createService({ pollApi: false, store, checkCooldownMs: 60_000 });
  const checked: string[] = [];
  let voted = false;
  service._fetchVoteCheck = async (userId) => {
    checked.push(userId);
    return voted;
  };

  assert.equal(await service.checkVote('42'), false);
  voted = true;
  assert.equal(await service.checkVote('42'), false, 'a second check inside the cooldown must not hit the api');
  assert.equal(await service.checkVote('43'), true);
  assert.equal(await service.checkVote('43'), true);

  assert.deepEqual(checked, ['42', '43']);
  assert.deepEqual(added, [['43']]);
  assert.equal(service.hasVoted('43'), true);
});

test('a failing vote check falls back to not voted', async () => {
  const service = createService();
  service._fetchVoteCheck = async () => {
    throw new Error('429 Too Many Requests');
  };

  assert.equal(await service.checkVote('42'), false);
  assert.equal(await createService({ apiKey: null }).checkVote('42'), false);
});

test('the mongo store inserts each voter once and loads new voters since the last sync', async () => {
  const docs = new Map<string, Doc>();
  const finds: Doc[] = [];
  let clock = new Date('2026-10-18T10:00:00Z');
  const collection: VoterStoreCollection = {
    createIndex: () => undefined,
    find: (filter) => {
      finds.push(filter);
      const since = (filter.firstSeenAt as { $gte?: Date } | undefined)?.$gte ?? null;
      return {
        toArray: async () => [...docs.values()].filter((doc) => !since || (doc.firstSeenAt as Date) >= since),
      };
    },
    updateOne: async (filter, update) => {
      const id = String(filter._id);
      if (!docs.has(id)) docs.set(id, { _id: id, ...(update.$setOnInsert as Doc) });
      return undefined;
    },
  };
  const store = new MongoVoterStore(collection, () => clock);

  await store.add('bot', ['1', '2']);
  clock = new Date('2026-10-18T11:00:00Z');
  await store.add('bot', ['2', '3']);

  const first = await store.load('bot', null);
  assert.deepEqual(first.voterIds.sort(), ['1', '2', '3']);
  assert.equal(docs.get('bot:2')?.firstSeenAt instanceof Date, true);
  assert.deepEqual(first.latestSeenAt, new Date('2026-10-18T11:00:00Z'));

  const next = await store.load('bot', first.latestSeenAt);
  assert.deepEqual(next.voterIds, ['3']);
  assert.deepEqual(finds[1], { botId: 'bot', firstSeenAt: { $gte: new Date('2026-10-18T11:00:00Z') } });
});

test('fluxerlist intervals default to the documented budget and never go below five minutes', () => {
  const base = { BOT_TOKEN: 'test-token', MONGODB_URI: 'mongodb://127.0.0.1:27017/test' };
  const defaults = loadConfig(base);
  assert.equal(defaults.fluxerlistStatsIntervalMs, 1_800_000);
  assert.equal(defaults.voteRefreshIntervalMs, 3_600_000);

  const tooFast = loadConfig({ ...base, FLUXERLIST_STATS_INTERVAL_MS: '60000', VOTE_REFRESH_INTERVAL_MS: '1000' });
  assert.equal(tooFast.fluxerlistStatsIntervalMs, 300_000);
  assert.equal(tooFast.voteRefreshIntervalMs, 300_000);
});
