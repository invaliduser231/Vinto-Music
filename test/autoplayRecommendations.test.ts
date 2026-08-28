import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

type PreviewCall = { query: string; startedAt: number };

function createRouter(options: {
  similar?: Array<{ artist: string; track: string; match: number }>;
  history?: Array<{ title: string; artist: string; duration: string }>;
  resolve?: (query: string) => unknown[];
  previewDelayMs?: number;
  slowQueries?: string[];
  slowDelayMs?: number;
  listeners?: number;
  similarFor?: (artist: string, track: string) => Array<{ artist: string; track: string; match: number }>;
  topTracksFor?: (artist: string) => Array<{ artist: string; track: string; match: number }>;
}) {
  const seeds: string[] = [];
  const previewCalls: PreviewCall[] = [];
  const enqueued: unknown[] = [];

  const player = {
    playing: false,
    historyTracks: options.history ?? [],
    searchBackend: 'deezer',
    async previewTracks(this: { searchBackend: string }, query: string) {
      if (this?.searchBackend !== 'deezer') {
        throw new TypeError('previewTracks lost its player binding');
      }
      previewCalls.push({ query, startedAt: Date.now() });
      if (options.slowQueries?.includes(query)) {
        await new Promise((resolve) => setTimeout(resolve, options.slowDelayMs ?? 5_000).unref?.());
      }
      if (options.previewDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.previewDelayMs));
      }
      return options.resolve ? options.resolve(query) : [{ title: query, duration: '3:00', source: 'deezer' }];
    },
    enqueueResolvedTracks(tracks: unknown[]) {
      enqueued.push(...tracks);
      return tracks;
    },
    async play() {
      this.playing = true;
    },
  };

  const session = {
    guildId: 'guild-1',
    sessionId: 'session-1',
    settings: { autoplayEnabled: true },
    connection: { channelId: 'voice-1' },
    player,
  };

  const router = new CommandRouter({
    config: { prefix: '!', sessionIdleMs: 300_000 },
    rest: {
      async sendTyping() {},
      async sendMessage() {},
      async editMessage() {},
    },
    gateway: {},
    sessions: {
      has: () => true,
      bindTextChannel: () => null,
      get: () => session,
      destroy: async () => null,
      on: () => null,
      sessions: new Map(),
    },
    voiceStateStore: { countUsersInChannel: () => options.listeners ?? 1 },
    lyrics: null,
    lastfm: {
      client: {
        async artistGetTopTracks(artist: string) {
          return options.topTracksFor ? options.topTracksFor(artist) : [];
        },
        async trackGetSimilar(artist: string, track: string) {
          seeds.push(`${artist} - ${track}`);
          return options.similarFor ? options.similarFor(artist, track) : options.similar;
        },
      },
      accounts: {},
      scrobbler: null,
    },
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);

  return { router, session, previewCalls, enqueued, seeds };
}

const AMY = { title: 'Back To Black', artist: 'Amy Winehouse', duration: '4:00' };

test('autoplay resolves its candidates concurrently instead of one after another', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [
      { artist: 'Amy Winehouse', track: 'Rehab', match: 1 },
      { artist: 'Amy Winehouse', track: 'Valerie', match: 0.9 },
      { artist: 'Duffy', track: 'Mercy', match: 0.8 },
      { artist: 'Adele', track: 'Rolling in the Deep', match: 0.7 },
    ],
    resolve: (query) => (query.includes('Rolling in the Deep') ? [{ title: query, duration: '3:00', source: 'deezer' }] : []),
    previewDelayMs: 60,
  });

  router.lastPlayedTracks.set('session-1', AMY);

  const startedAt = Date.now();
  const title = await router._tryAutoplay(session as never);
  const elapsed = Date.now() - startedAt;

  assert.equal(title, 'Adele - Rolling in the Deep');
  assert.equal(previewCalls.length, 4, 'all candidates are looked up in one round');
  assert.ok(elapsed < 200, `four lookups took ${elapsed}ms, so they did not run in sequence`);
});

test('a hanging lookup is cut off by the deadline instead of stalling autoplay', async () => {
  const { router, session } = createRouter({
    similar: [
      { artist: 'Amy Winehouse', track: 'Rehab', match: 1 },
      { artist: 'Duffy', track: 'Mercy', match: 0.9 },
    ],
    resolve: (query) => (query.includes('Rehab') ? [] : [{ title: 'Mercy', artist: 'Duffy', duration: '3:41', source: 'deezer' }]),
    slowQueries: ['Amy Winehouse - Rehab'],
    slowDelayMs: 30_000,
  });

  router.lastPlayedTracks.set('session-1', AMY);

  const startedAt = Date.now();
  const title = await router._tryAutoplay(session as never);
  const elapsed = Date.now() - startedAt;

  assert.equal(title, 'Mercy');
  assert.ok(elapsed < 4_000, `waited ${elapsed}ms although the deadline is 3s`);
});

test('a remix by a different artist is not accepted as the suggested track', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [
      { artist: 'Sade', track: 'Like a Tattoo', match: 1 },
      { artist: 'Duffy', track: 'Mercy', match: 0.9 },
    ],
    resolve: (query) => (query.includes('Like a Tattoo')
      ? [{ title: "Sade Like A Tattoo (Skep's Jungle Edit)", artist: 'Skep', duration: '7:01', source: 'deezer' }]
      : [{ title: 'Mercy', artist: 'Duffy', duration: '3:41', source: 'deezer' }]),
  });

  router.lastPlayedTracks.set('session-1', AMY);
  const title = await router._tryAutoplay(session as never);

  assert.equal(title, 'Mercy', 'the jungle edit by Skep is not Sade');
  assert.equal((enqueued[0] as { artist?: string }).artist, 'Duffy');
});

test('the exact artist wins when the search offers a near namesake too', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [{ artist: 'Adele', track: "I'll Be Waiting", match: 1 }],
    resolve: () => [
      { title: "I'll Be Waiting", artist: 'Adele Harley', duration: '3:29', source: 'deezer' },
      { title: "I'll Be Waiting", artist: 'Adele', duration: '4:01', source: 'deezer' },
    ],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), "I'll Be Waiting");
  assert.equal((enqueued[0] as { artist?: string }).artist, 'Adele');
});

test('a near namesake is still used when nothing closer turns up', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [{ artist: 'Adele', track: "I'll Be Waiting", match: 1 }],
    resolve: () => [{ title: "I'll Be Waiting", artist: 'Adele Harley', duration: '3:29', source: 'deezer' }],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), "I'll Be Waiting");
  assert.equal((enqueued[0] as { artist?: string }).artist, 'Adele Harley');
});

test('a leading article in the artist name is not treated as a mismatch', async () => {
  const { router, session } = createRouter({
    similar: [{ artist: 'The Beatles', track: 'Come Together', match: 1 }],
    resolve: () => [{ title: 'Come Together', artist: 'Beatles', duration: '4:20', source: 'deezer' }],
  });

  router.lastPlayedTracks.set('session-1', AMY);
  assert.equal(await router._tryAutoplay(session as never), 'Come Together');
});

test('the highest ranked suggestion wins, not the fastest lookup', async () => {
  const { router, session } = createRouter({
    similar: [
      { artist: 'Amy Winehouse', track: 'Rehab', match: 1 },
      { artist: 'Duffy', track: 'Mercy', match: 0.9 },
    ],
    resolve: (query) => [{ title: query.split(' - ')[1], artist: query.split(' - ')[0], duration: '3:30', source: 'deezer' }],
    slowQueries: ['Amy Winehouse - Rehab'],
    slowDelayMs: 200,
  });

  router.lastPlayedTracks.set('session-1', AMY);
  assert.equal(await router._tryAutoplay(session as never), 'Rehab');
});

test('autoplay does not suggest the track that just played', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [
      { artist: 'Amy Winehouse', track: 'Back To Black', match: 1 },
      { artist: 'Amy Winehouse', track: 'Rehab', match: 0.9 },
    ],
  });

  router.lastPlayedTracks.set('session-1', AMY);
  const title = await router._tryAutoplay(session as never);

  assert.equal(title, 'Amy Winehouse - Rehab');
  assert.deepEqual(previewCalls.map((call) => call.query), ['Amy Winehouse - Rehab']);
});

test('autoplay skips what is still in the session history', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [
      { artist: 'Amy Winehouse', track: 'Rehab', match: 1 },
      { artist: 'Duffy', track: 'Mercy', match: 0.9 },
    ],
    history: [
      { title: 'Rehab', artist: 'Amy Winehouse', duration: '3:34' },
    ],
  });

  router.lastPlayedTracks.set('session-1', AMY);
  const title = await router._tryAutoplay(session as never);

  assert.equal(title, 'Duffy - Mercy');
  assert.deepEqual(previewCalls.map((call) => call.query), ['Duffy - Mercy']);
});

test('a suggestion that only differs by a featuring credit counts as recently played', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [
      { artist: 'Kraftklub', track: 'Fallen in Liebe feat. Nina Chuba', match: 1 },
      { artist: 'Kraftklub', track: 'Karten auf den Tisch', match: 0.9 },
    ],
    history: [
      { title: 'Fallen in Liebe', artist: 'Kraftklub', duration: '2:20' },
    ],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), 'Kraftklub - Karten auf den Tisch');
  assert.deepEqual(previewCalls.map((call) => call.query), ['Kraftklub - Karten auf den Tisch']);
});

test('autoplay stays quiet when nothing resolves', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
    resolve: () => [],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(enqueued.length, 0);
});

test('autoplay stops once the channel is empty so the session can time out', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
    listeners: 0,
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0, 'no lookups for an empty room');
});

test('autoplay stays off when the guild did not enable it', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
  });

  session.settings.autoplayEnabled = false;
  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0);
});

test('the next suggestion follows what last.fm proposed, not the stand-in that got played', async () => {
  const { router, session, seeds } = createRouter({
    similarFor: (artist, track) => {
      if (artist === 'Amy Winehouse') return [{ artist: 'Adele', track: "I'll Be Waiting", match: 1 }];
      if (artist === 'Adele') return [{ artist: 'Duffy', track: 'Mercy', match: 1 }];
      return [];
    },
    resolve: (query) => (query.includes('Waiting')
      ? [{ title: "I'll Be Waiting", artist: 'Adele Harley', duration: '3:29', source: 'deezer' }]
      : [{ title: 'Mercy', artist: 'Duffy', duration: '3:41', source: 'deezer' }]),
  });

  router.lastPlayedTracks.set('session-1', AMY);
  assert.equal(await router._tryAutoplay(session as never), "I'll Be Waiting");

  router.lastPlayedTracks.set('session-1', {
    title: "I'll Be Waiting",
    artist: 'Adele Harley',
    duration: '3:29',
  });
  session.player.playing = false;

  assert.equal(await router._tryAutoplay(session as never), 'Mercy', 'the chain continues from Adele');
  assert.deepEqual(seeds, ['Amy Winehouse - Back To Black', "Adele - I'll Be Waiting"]);
});

test('the artist top tracks carry the chain when last.fm knows no similar tracks', async () => {
  const { router, session, previewCalls } = createRouter({
    similarFor: () => [],
    topTracksFor: (artist) => (artist === 'Amy Winehouse'
      ? [{ artist: 'Amy Winehouse', track: 'Valerie', match: 400 }]
      : []),
    resolve: () => [{ title: 'Valerie', artist: 'Amy Winehouse', duration: '3:38', source: 'deezer' }],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), 'Valerie');
  assert.deepEqual(previewCalls.map((call) => call.query), ['Amy Winehouse - Valerie']);
});

test('autoplay only gives up when neither source knows anything', async () => {
  const { router, session, previewCalls } = createRouter({
    similarFor: () => [],
    topTracksFor: () => [],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0);
});
