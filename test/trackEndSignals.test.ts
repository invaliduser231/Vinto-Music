import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

type Signal = { guildId: string; userId: string; signal: string };

function createRouter() {
  const signals: Signal[] = [];
  const appended: unknown[] = [];
  const handlers = new Map<string, (payload?: unknown) => Promise<void>>();

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
      get: () => null,
      destroy: async () => null,
      on: (event: string, handler: (payload?: unknown) => Promise<void>) => {
        handlers.set(event, handler);
        return null;
      },
      sessions: new Map(),
    },
    voiceStateStore: { countUsersInChannel: () => 1 },
    lyrics: null,
    library: {
      async appendGuildHistory(guildId: string, track: unknown) {
        appended.push({ guildId, track });
      },
      async recordUserSignal(guildId: string, userId: string, signal: string) {
        signals.push({ guildId, userId, signal });
      },
    },
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);

  return { router, signals, appended, handlers };
}

const SESSION = { guildId: '1474874137937518680', sessionId: 'session-1' };
const TRACK = { title: 'Glatteis', duration: '3:22', requestedBy: '100000000000000001' };

test('a track that ran to the end is recorded as a play', async () => {
  const { signals, handlers } = createRouter();

  await handlers.get('trackEnd')?.({ session: SESSION, track: TRACK, skipped: false });

  assert.deepEqual(signals, [{
    guildId: SESSION.guildId,
    userId: TRACK.requestedBy,
    signal: 'play',
  }]);
});

test('a skipped track is still recorded as a skip', async () => {
  const { signals, handlers } = createRouter();

  await handlers.get('trackEnd')?.({ session: SESSION, track: TRACK, skipped: true });

  assert.deepEqual(signals.map((entry) => entry.signal), ['skip']);
});

test('a seek restart records nothing at all', async () => {
  const { signals, appended, handlers } = createRouter();

  await handlers.get('trackEnd')?.({ session: SESSION, track: TRACK, seekRestart: true });

  assert.equal(signals.length, 0);
  assert.equal(appended.length, 0);
});

test('a track without a resolvable requester is only added to the history', async () => {
  const { signals, appended, handlers } = createRouter();

  await handlers.get('trackEnd')?.({
    session: SESSION,
    track: { ...TRACK, requestedBy: null },
    skipped: false,
  });

  assert.equal(signals.length, 0);
  assert.equal(appended.length, 1);
});
