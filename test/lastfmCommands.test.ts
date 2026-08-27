import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { createTranslator } from '../src/i18n/index.ts';
import { ValidationError } from '../src/core/errors.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

const GUILD_ID = '1474874137937518680';
const AUTHOR_ID = '100000000000000001';
const OTHER_ID = '100000000000000002';

function buildRegistry() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry;
}

function createLastFm(overrides: Record<string, unknown> = {}) {
  const linked = new Map<string, string>();
  const calls: string[] = [];
  const loveCalls: string[] = [];

  const client = {
    async loveTrack(_sessionKey: string, artist: string, track: string) {
      loveCalls.push(`love:${artist} - ${track}`);
    },
    async unloveTrack(_sessionKey: string, artist: string, track: string) {
      loveCalls.push(`unlove:${artist} - ${track}`);
    },
    async getToken() {
      calls.push('getToken');
      return 'token-1';
    },
    async getSession(token: string) {
      calls.push(`getSession:${token}`);
      return { name: 'listener', key: 'session-key' };
    },
    buildAuthUrl(token: string) {
      return `https://www.last.fm/api/auth/?api_key=key&token=${token}`;
    },
    async userGetRecentTracks() {
      return [{
        artist: 'M83',
        track: 'Midnight City',
        album: null,
        url: null,
        imageUrl: null,
        nowPlaying: false,
        playedAt: new Date('2026-03-01T20:00:00.000Z'),
      }];
    },
    async userGetTopArtists() {
      return [{ name: 'M83', artist: null, url: null, playcount: 120 }];
    },
    async userGetInfo() {
      return {
        name: 'listener',
        realname: null,
        url: 'https://www.last.fm/user/listener',
        playcount: 4321,
        registeredAt: new Date('2020-01-01T00:00:00.000Z'),
        imageUrl: null,
        country: 'DE',
      };
    },
    ...overrides,
  };

  const accounts = {
    linked,
    calls,
    async get(userId: string) {
      const username = linked.get(userId);
      if (!username) return null;
      return {
        userId,
        username,
        scrobblingEnabled: true,
        scrobbleCount: 12,
        lovedCount: 0,
        streakDays: 3,
        streakLastDay: '2026-03-01',
        lastScrobbleAt: new Date(),
        connectedAt: new Date(),
      };
    },
    async getSessionKey(userId: string) {
      return linked.has(userId) ? 'session-key' : null;
    },
    async link(userId: string, username: string) {
      calls.push(`link:${userId}:${username}`);
      linked.set(userId, username);
      return null;
    },
    async unlink(userId: string) {
      return linked.delete(userId);
    },
    async setScrobblingEnabled() {
      return null;
    },
    async listTop() {
      return [
        { userId: AUTHOR_ID, username: 'listener', scrobbleCount: 30 },
        { userId: OTHER_ID, username: 'other', scrobbleCount: 10 },
      ];
    },
    async recordLove() {},
  };

  return { client, accounts, calls, linked, loveCalls };
}

function createContext(overrides: Record<string, unknown> = {}) {
  const replyCalls: string[] = [];
  const paginated: unknown[] = [];
  const enqueued: unknown[] = [];
  const lastfm = (overrides.lastfm as ReturnType<typeof createLastFm> | undefined) ?? createLastFm();

  const context = {
    guildId: GUILD_ID,
    channelId: 'text-1',
    authorId: AUTHOR_ID,
    botUserId: 'bot-1',
    args: [] as string[],
    prefix: '!',
    config: { prefix: '!', maxConcurrentVoiceChannelsPerGuild: 5 },
    message: { guild_id: GUILD_ID, author: { id: AUTHOR_ID } },
    guildConfig: {
      guildId: GUILD_ID,
      prefix: '!',
      settings: {
        dedupeEnabled: false,
        stayInVoiceEnabled: false,
        minimalMode: false,
        autoplayEnabled: false,
        volumePercent: 100,
        voteSkipRatio: 0.5,
        voteSkipMinVotes: 1,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
    lastfm: { client: lastfm.client, accounts: lastfm.accounts, scrobbler: null },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        return 'voice-1';
      },
      countUsersInChannel() {
        return 1;
      },
      getUsersInChannel() {
        return ['bot-1', AUTHOR_ID];
      },
    },
    sessions: {
      has() {
        return true;
      },
      listByGuild() {
        return [{ targetVoiceChannelId: 'voice-1', connection: { channelId: 'voice-1' } }];
      },
      async ensure() {
        return {
          guildId: GUILD_ID,
          sessionId: 'session-1',
          textChannelId: 'text-1',
          settings: { dedupeEnabled: false, stayInVoiceEnabled: false, djRoleIds: new Set<string>() },
          connection: {
            connected: true,
            channelId: 'voice-1',
            async connect() {},
            hasUsablePlayer() {
              return true;
            },
          },
          player: {
            playing: false,
            displayTrack: { title: 'Midnight City', artist: 'M83', duration: '4:03', source: 'deezer' },
            currentTrack: { title: 'Midnight City', artist: 'M83', duration: '4:03', source: 'deezer' },
            async previewTracks(query: string) {
              return [{ title: query, url: 'https://example.com', duration: '4:03', source: 'youtube' }];
            },
            enqueueResolvedTracks(tracks: unknown[]) {
              enqueued.push(...tracks);
              return tracks;
            },
            async play() {},
          },
        };
      },
      get() {
        return this.ensureSync();
      },
      ensureSync() {
        return {
          guildId: GUILD_ID,
          sessionId: 'session-1',
          settings: { djRoleIds: new Set<string>() },
          connection: { channelId: 'voice-1' },
          player: {
            playing: false,
            displayTrack: { title: 'Midnight City', artist: 'M83', duration: '4:03', source: 'deezer' },
            currentTrack: { title: 'Midnight City', artist: 'M83', duration: '4:03', source: 'deezer' },
          },
        };
      },
      bindTextChannel() {},
      markSnapshotDirty() {},
      async destroy() {},
      async syncPersistentVoiceState() {},
      adoptVoiceChannel() {},
    },
    t: createTranslator('en'),
    reply: {
      async info(text: string, fields?: Array<{ name: string; value: string }>) {
        replyCalls.push(`info:${text}:${fields?.map((field) => field.value).join('|') ?? ''}`);
      },
      async success(text: string) {
        replyCalls.push(`success:${text}`);
      },
      async warning(text: string) {
        replyCalls.push(`warning:${text}`);
      },
      async error(text: string) {
        replyCalls.push(`error:${text}`);
      },
    },
    async sendPaginated(pages: unknown[]) {
      paginated.push(...pages);
    },
    ...overrides,
  };

  return { context, replyCalls, paginated, enqueued, lastfm };
}

function resolveExecute(name: string): Execute {
  const command = buildRegistry().resolve(name);
  const execute = command?.execute as Execute | undefined;
  assert.ok(execute, `command ${name} is not registered`);
  return execute;
}

test('lastfm is reachable through its aliases', () => {
  const registry = buildRegistry();
  assert.equal(registry.resolve('fm')?.name, 'lastfm');
  assert.equal(registry.resolve('lfm')?.name, 'lastfm');
  assert.equal(registry.resolve('fmp')?.name, 'fmplay');
  assert.equal(registry.resolve('unlike')?.name, 'unlove');
});

test('commands refuse to run when last.fm is not configured', async () => {
  const execute = resolveExecute('lastfm');
  const { context } = createContext({ lastfm: null, args: ['status'] });

  await assert.rejects(() => Promise.resolve(execute(context)), ValidationError);
});

test('connect hands out a link first and finishes on the second run', async () => {
  const execute = resolveExecute('lastfm');
  const shared = createLastFm();
  const first = createContext({ args: ['connect'], lastfm: shared });

  await execute(first.context);

  assert.ok(first.replyCalls[0]?.includes('https://www.last.fm/api/auth/?api_key=key&token=token-1'));
  assert.deepEqual(shared.calls, ['getToken']);
  assert.equal(shared.linked.size, 0);

  const second = createContext({ args: ['connect'], lastfm: shared });
  await execute(second.context);

  assert.deepEqual(shared.calls, ['getToken', 'getSession:token-1', `link:${AUTHOR_ID}:listener`]);
  assert.ok(second.replyCalls.some((entry) => entry.startsWith('success:') && entry.includes('listener')));
});

test('status explains how to link when nothing is connected', async () => {
  const execute = resolveExecute('lastfm');
  const { context, replyCalls } = createContext({ args: ['status'] });

  await execute(context);

  assert.equal(replyCalls.length, 1);
  assert.ok(replyCalls[0]?.startsWith('info:You have not linked'));
});

test('status shows the linked account with its counters', async () => {
  const execute = resolveExecute('lastfm');
  const shared = createLastFm();
  shared.linked.set(AUTHOR_ID, 'listener');
  const { context, replyCalls } = createContext({ args: ['status'], lastfm: shared });

  await execute(context);

  assert.ok(replyCalls[0]?.includes('listener'));
  assert.ok(replyCalls[0]?.includes('12'));
});

test('an unknown subcommand is rejected', async () => {
  const execute = resolveExecute('lastfm');
  const { context } = createContext({ args: ['nonsense'] });

  await assert.rejects(() => Promise.resolve(execute(context)), ValidationError);
});

test('the leaderboard lists linked accounts by scrobble count', async () => {
  const execute = resolveExecute('lastfm');
  const { context, paginated } = createContext({ args: ['leaderboard'] });

  await execute(context);

  assert.equal(paginated.length, 1);
  const rendered = JSON.stringify(paginated[0]);
  assert.match(rendered, /1\. listener \(30\)/);
  assert.match(rendered, /2\. other \(10\)/);
});

test('fmplay queues the last scrobbled track', async () => {
  const execute = resolveExecute('fmplay');
  const shared = createLastFm();
  shared.linked.set(AUTHOR_ID, 'listener');
  const { context, enqueued, replyCalls } = createContext({ lastfm: shared });

  await execute(context);

  assert.equal(enqueued.length, 1);
  assert.equal((enqueued[0] as { title?: string }).title, 'M83 - Midnight City');
  assert.ok(replyCalls.some((entry) => entry.startsWith('success:')));
});

test('fmplay needs a linked account', async () => {
  const execute = resolveExecute('fmplay');
  const { context } = createContext({});

  await assert.rejects(() => Promise.resolve(execute(context)), ValidationError);
});

test('blend refuses when nobody in the channel is linked', async () => {
  const execute = resolveExecute('lastfm');
  const { context, replyCalls } = createContext({ args: ['blend'] });

  await execute(context);

  assert.ok(replyCalls.some((entry) => entry.startsWith('warning:Nobody in this voice channel')));
});

test('compare needs a second person', async () => {
  const execute = resolveExecute('lastfm');
  const shared = createLastFm();
  shared.linked.set(AUTHOR_ID, 'listener');

  const missing = createContext({ args: ['compare'], lastfm: shared });
  await assert.rejects(() => Promise.resolve(execute(missing.context)), ValidationError);

  const self = createContext({ args: ['compare', `<@${AUTHOR_ID}>`], lastfm: shared });
  await assert.rejects(() => Promise.resolve(execute(self.context)), ValidationError);
});

test('autoplay reports and changes the guild setting', async () => {
  const execute = resolveExecute('autoplay');
  const patches: unknown[] = [];

  const show = createContext({
    args: [],
    guildConfigs: {
      async get() {
        return show.context.guildConfig;
      },
      async update(_guildId: string, patch: unknown) {
        patches.push(patch);
        return show.context.guildConfig;
      },
    },
  });

  await execute(show.context);
  assert.ok(show.replyCalls[0]?.startsWith('info:Autoplay is off.'));
  assert.equal(patches.length, 0);
});

test('love marks the playing track and unlove clears it', async () => {
  const shared = createLastFm();
  shared.linked.set(AUTHOR_ID, 'listener');

  const love = createContext({ lastfm: shared });
  await resolveExecute('love')(love.context);

  const unlove = createContext({ lastfm: shared });
  await resolveExecute('unlove')(unlove.context);

  assert.deepEqual(shared.loveCalls, ['love:M83 - Midnight City', 'unlove:M83 - Midnight City']);
  assert.ok(love.replyCalls[0]?.startsWith('success:Loved M83 - Midnight City'));
});
