import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

type PreviewCall = { query: string; startedAt: number };

function createRouter(options: {
  similar: Array<{ artist: string; track: string; match: number }>;
  history?: Array<{ title: string; artist: string; duration: string }>;
  resolve?: (query: string) => unknown[];
  previewDelayMs?: number;
}) {
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
    voiceStateStore: { countUsersInChannel: () => 1 },
    lyrics: null,
    lastfm: {
      client: {
        async trackGetSimilar() {
          return options.similar;
        },
      },
      accounts: {},
      scrobbler: null,
    },
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);

  return { router, session, previewCalls, enqueued };
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

test('autoplay stays quiet when nothing resolves', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
    resolve: () => [],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(enqueued.length, 0);
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
