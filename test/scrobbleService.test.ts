import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ScrobbleService } from '../src/bot/services/scrobbleService.ts';
import { LastFmApiError } from '../src/integrations/lastfm/LastFmClient.ts';

type ScrobbleCall = { sessionKey: string; artist: string; track: string; timestamp: number };

function createClient(overrides: { onScrobble?: (call: ScrobbleCall) => void } = {}) {
  const scrobbles: ScrobbleCall[] = [];
  const nowPlaying: string[] = [];

  return {
    scrobbles,
    nowPlaying,
    async updateNowPlaying(sessionKey: string) {
      nowPlaying.push(sessionKey);
    },
    async scrobble(sessionKey: string, entries: Array<{ artist: string; track: string; timestamp: number }>) {
      const entry = entries[0]!;
      const call = { sessionKey, artist: entry.artist, track: entry.track, timestamp: entry.timestamp };
      overrides.onScrobble?.(call);
      scrobbles.push(call);
      return entries.length;
    },
  };
}

function createAccounts(userIds: string[]) {
  const linked = new Set(userIds);
  const recorded: string[] = [];
  const queued: Array<{ userId: string }> = [];
  const unlinked: string[] = [];
  const disabled = new Set<string>();

  return {
    linked,
    recorded,
    queued,
    unlinked,
    disable(userId: string) {
      disabled.add(userId);
    },
    async get(userId: string) {
      if (!linked.has(userId)) return null;
      return {
        userId,
        username: `user-${userId}`,
        scrobblingEnabled: !disabled.has(userId),
        scrobbleCount: 0,
        lovedCount: 0,
        streakDays: 0,
        streakLastDay: null,
        lastScrobbleAt: null,
        connectedAt: null,
      };
    },
    async getSessionKey(userId: string) {
      return linked.has(userId) ? `session-${userId}` : null;
    },
    async recordScrobble(userId: string) {
      recorded.push(userId);
      return { scrobbleCount: recorded.filter((id) => id === userId).length, streakDays: 1, streakExtended: true };
    },
    async unlink(userId: string) {
      linked.delete(userId);
      unlinked.push(userId);
      return true;
    },
    async queueRetry(userId: string) {
      queued.push({ userId });
    },
    async listDueRetries() {
      return [];
    },
    async resolveRetry() {},
    async countLinked() {
      return linked.size;
    },
  };
}

function createVoiceStateStore(listeners: string[]) {
  return {
    listeners,
    getUsersInChannel() {
      return [...this.listeners];
    },
  };
}

function createService(options: {
  listeners: string[];
  linked: string[];
  onScrobble?: (call: ScrobbleCall) => void;
}) {
  const client = createClient(options.onScrobble ? { onScrobble: options.onScrobble } : {});
  const accounts = createAccounts(options.linked);
  const voiceStateStore = createVoiceStateStore(options.listeners);
  const sessions = new EventEmitter();
  const messages: string[] = [];

  const service = new ScrobbleService({
    client: client as never,
    accounts: accounts as never,
    voiceStateStore: voiceStateStore as never,
    rest: {
      async sendMessage(_channelId: string, payload: { content?: string | null | undefined }) {
        messages.push(String(payload.content ?? ''));
      },
    },
    botUserId: 'bot-1',
    minDurationSec: 30,
  });
  service.bind(sessions as never);

  return { service, client, accounts, voiceStateStore, sessions, messages };
}

const SESSION = {
  guildId: '111111111',
  sessionId: 'session-1',
  textChannelId: '222222222',
  settings: { musicLogChannelId: null, minimalMode: false },
  connection: { channelId: '333333333' },
};

const TRACK = { title: 'Midnight City', artist: 'M83', duration: '4:03', source: 'deezer' };

function startTrack(sessions: EventEmitter, track: unknown = TRACK) {
  sessions.emit('trackStart', { session: SESSION, track });
}

function endTrack(sessions: EventEmitter, extra: Record<string, unknown> = {}) {
  sessions.emit('trackEnd', { session: SESSION, track: TRACK, ...extra });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('a track heard past the halfway point is scrobbled for every linked listener', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001', '1000000002'],
    linked: ['1000000001', '1000000002'],
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { startedAtMs: number; listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 130_000);
  playback.listenedMs.set('1000000002', 130_000);
  playback.startedAtMs = 1_700_000_000_000;

  endTrack(sessions);
  await settle();

  assert.equal(client.scrobbles.length, 2);
  assert.equal(client.scrobbles[0]?.artist, 'M83');
  assert.equal(client.scrobbles[0]?.track, 'Midnight City');
  assert.equal(client.scrobbles[0]?.timestamp, 1_700_000_000);
  assert.deepEqual(
    client.scrobbles.map((call) => call.sessionKey).sort(),
    ['session-1000000001', 'session-1000000002'],
  );
});

test('a track skipped early is not scrobbled', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 10_000);

  endTrack(sessions, { skipped: true });
  await settle();

  assert.equal(client.scrobbles.length, 0);
});

test('four minutes of a long track are enough', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions, { ...TRACK, duration: '20:00' });
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 245_000);

  endTrack(sessions);
  await settle();

  assert.equal(client.scrobbles.length, 1);
});

test('listeners without a linked account are ignored', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001', '1000000002'],
    linked: ['1000000001'],
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 130_000);
  playback.listenedMs.set('1000000002', 130_000);

  endTrack(sessions);
  await settle();

  assert.equal(client.scrobbles.length, 1);
  assert.equal(client.scrobbles[0]?.sessionKey, 'session-1000000001');
});

test('a paused account keeps its link but stops scrobbling', async () => {
  const { service, client, accounts, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });
  accounts.disable('1000000001');

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 130_000);

  endTrack(sessions);
  await settle();

  assert.equal(client.scrobbles.length, 0);
  assert.equal(accounts.linked.has('1000000001'), true);
});

test('a seek restart does not produce a scrobble', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 200_000);

  endTrack(sessions, { seekRestart: true });
  await settle();

  assert.equal(client.scrobbles.length, 0);
});

test('a live stream never starts a scrobble window', async () => {
  const { service, client, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions, { title: 'Some Station', duration: 'Unknown', source: 'radio', isLive: true });
  await settle();

  assert.equal((service as never as { active: Map<string, unknown> }).active.size, 0);

  endTrack(sessions);
  await settle();
  assert.equal(client.scrobbles.length, 0);
});

test('now playing goes out at track start for every linked listener', async () => {
  const { client, sessions } = createService({
    listeners: ['1000000001', '1000000002'],
    linked: ['1000000001', '1000000002'],
  });

  startTrack(sessions);
  await settle();

  assert.deepEqual(client.nowPlaying.sort(), ['session-1000000001', 'session-1000000002']);
});

test('a listener joining mid track collects time from the tick', async () => {
  const { service, voiceStateStore, client, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001', '1000000002'],
  });

  startTrack(sessions);
  await settle();

  voiceStateStore.listeners.push('1000000002');
  const internals = service as never as {
    active: Map<string, { lastTickMs: number; listenedMs: Map<string, number> }>;
    _accumulate: (playback: unknown, now: number) => void;
  };
  const playback = internals.active.get('session-1')!;
  playback.lastTickMs = Date.now() - 130_000;
  internals._accumulate(playback, Date.now());

  endTrack(sessions);
  await settle();

  assert.equal(client.scrobbles.length, 2);
});

test('the bot itself is never counted as a listener', async () => {
  const { service, sessions } = createService({
    listeners: ['bot-1', '1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  assert.deepEqual([...playback.listenedMs.keys()], ['1000000001']);
});

test('an invalid session key unlinks the account and warns once', async () => {
  const { service, accounts, messages, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
    onScrobble: () => {
      throw new LastFmApiError('Invalid session key', 9, 403);
    },
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 130_000);

  endTrack(sessions);
  await settle();

  assert.deepEqual(accounts.unlinked, ['1000000001']);
  assert.equal(accounts.queued.length, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /1000000001/);
});

test('a transient failure is queued for a later retry', async () => {
  const { service, accounts, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
    onScrobble: () => {
      throw new Error('network down');
    },
  });

  startTrack(sessions);
  await settle();

  const playback = (service as never as { active: Map<string, { listenedMs: Map<string, number> }> }).active.get('session-1')!;
  playback.listenedMs.set('1000000001', 130_000);

  endTrack(sessions);
  await settle();

  assert.deepEqual(accounts.queued, [{ userId: '1000000001' }]);
  assert.deepEqual(accounts.unlinked, []);
});

test('destroying a session drops its pending playback', async () => {
  const { service, sessions } = createService({
    listeners: ['1000000001'],
    linked: ['1000000001'],
  });

  startTrack(sessions);
  await settle();
  assert.equal((service as never as { active: Map<string, unknown> }).active.size, 1);

  sessions.emit('destroyed', { session: SESSION });
  assert.equal((service as never as { active: Map<string, unknown> }).active.size, 0);
});

test('countLinkedListeners reports only listeners with a linked account', async () => {
  const { service } = createService({
    listeners: ['bot-1', '1000000001', '1000000002'],
    linked: ['1000000001'],
  });

  assert.equal(await service.countLinkedListeners('111111111', '333333333'), 1);
  assert.equal(await service.countLinkedListeners('', ''), 0);
});
