import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

type PlayExecute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

function buildPlayCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('play');
}

type TestTrack = {
  title: string;
  duration: string;
  url: string;
  source: string;
  requestedBy?: string | null;
  isLive?: boolean;
};

type SessionPlayer = {
  playing?: boolean;
  currentTrack?: TestTrack | null;
  previewTracks?: (query: string, options?: { requestedBy?: string | null; limit?: number }) => Promise<TestTrack[]>;
  createTrackFromData?: (track: TestTrack, requestedBy: string) => TestTrack;
  prefetchTrackPlayback?: (track: TestTrack) => Promise<void>;
  enqueueResolvedTracks?: (tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) => TestTrack[];
  skip?: () => boolean;
  play?: () => Promise<void>;
  hydrateTrackMetadata?: (track: TestTrack, options?: { requestedBy?: string | null }) => Promise<TestTrack | null>;
};

type SessionConnection = {
  connected?: boolean;
  connect?: (channelId: string) => Promise<void>;
  hasUsablePlayer?: () => boolean;
};

function createBaseContext(sessionPlayer: SessionPlayer, calls: string[], options: { connection?: SessionConnection } = {}) {
  const connection = {
    connected: true,
    async connect(channelId: string) {
      calls.push(`connect:${channelId}`);
      connection.connected = true;
    },
    hasUsablePlayer() {
      return true;
    },
    ...options.connection,
  };

  return {
    guildId: 'guild-1',
    channelId: 'text-1',
    authorId: 'user-1',
    args: ['lofi'],
    prefix: '!',
    config: {
      prefix: '!',
      maxPlaylistTracks: 25,
      enableEmbeds: true,
    },
    message: {
      id: 'message-1',
      guild_id: 'guild-1',
      author: { id: 'user-1' },
    },
    voiceStateStore: {
      resolveMemberVoiceChannel() {
        calls.push('resolveVoice');
        return 'voice-1';
      },
    },
    sessions: {
      has() {
        calls.push('has');
        return true;
      },
      async ensure() {
        calls.push('ensure');
        return {
          guildId: 'guild-1',
          connection,
          settings: {
            dedupeEnabled: false,
          },
          player: sessionPlayer,
        };
      },
      bindTextChannel(guildId: string, channelId: string) {
        calls.push(`bind:${guildId}:${channelId}`);
      },
      async destroy() {},
    },
    rest: {
      async sendMessage() {
        calls.push('sendMessage');
        return { id: 'progress-1' };
      },
      async editMessage(_channelId: string, _messageId: string, payload: { embeds?: Array<{ description?: string }>; content?: string }) {
        calls.push(`edit:${payload?.embeds?.[0]?.description ?? payload?.content ?? ''}`);
        return { id: 'progress-1' };
      },
    },
    reply: {
      async info(text: string) {
        calls.push(`reply:info:${text}`);
      },
      async success(text: string) {
        calls.push(`reply:success:${text}`);
      },
      async warning(text: string) {
        calls.push(`reply:warning:${text}`);
      },
      async error(text: string) {
        calls.push(`reply:error:${text}`);
      },
    },
    async safeTyping() {
      calls.push('safeTyping');
    },
    async withGuildOpLock(_name: string, fn: () => Promise<unknown>) {
      calls.push('lock');
      return fn();
    },
  };
}

test('play interrupts an active live radio stream and starts the new selection next', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);
  const calls: string[] = [];
  const playerCalls: string[] = [];
  const resolvedTrack = {
    title: 'Fresh Track',
    duration: '03:30',
    url: 'https://example.com/fresh',
    source: 'youtube',
  };

  const ctx = createBaseContext({
    playing: true,
    currentTrack: {
      title: 'Retro FM',
      duration: 'Live',
      url: 'https://radio.example.com/live',
      source: 'radio-stream',
      isLive: true,
    },
    async previewTracks() {
      playerCalls.push('previewTracks');
      return [resolvedTrack];
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
    async play() {
      playerCalls.push('play');
    },
  }, calls);

  await execute(ctx);

  assert.ok(calls.includes('bind:guild-1:text-1'));
  assert.deepEqual(playerCalls, [
    'previewTracks',
    'createTrackFromData:user-1',
    'enqueue:{"playNext":true,"dedupe":false}',
    'skip',
  ]);
  assert.ok(calls.some((entry) => entry.includes('Stopped live stream. Playing now:')));
});

test('play keeps normal queue behavior when the current track is not live', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);
  const calls: string[] = [];
  const playerCalls: string[] = [];
  const resolvedTrack = {
    title: 'Next Song',
    duration: '02:45',
    url: 'https://example.com/next',
    source: 'youtube',
  };

  const ctx = createBaseContext({
    playing: true,
    currentTrack: {
      title: 'Regular Song',
      duration: '03:00',
      url: 'https://example.com/current',
      source: 'youtube',
      isLive: false,
    },
    async previewTracks() {
      playerCalls.push('previewTracks');
      return [resolvedTrack];
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
    async play() {
      playerCalls.push('play');
    },
  }, calls);

  await execute(ctx);

  assert.deepEqual(playerCalls, [
    'previewTracks',
    'createTrackFromData:user-1',
    'enqueue:{"playNext":false,"dedupe":false}',
  ]);
  assert.ok(calls.some((entry) => entry.includes('Added to queue:')));
});

test('play starts the first playlist track immediately and loads the rest in the background', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let backgroundResolved = false;
  let resolveBackground: ((tracks: TestTrack[]) => void) | null = null;

  const firstTrack = {
    title: 'Track 1',
    duration: '03:00',
    url: 'https://example.com/track-1',
    source: 'youtube-playlist',
  };
  const secondTrack = {
    title: 'Track 2',
    duration: '03:30',
    url: 'https://example.com/track-2',
    source: 'youtube-playlist',
  };

  const ctx = createBaseContext({
    playing: false,
    async previewTracks(_query: string, options?: { limit?: number }) {
      playerCalls.push(`previewTracks:${options?.limit ?? 'full'}`);
      if (options?.limit === 1) {
        return [firstTrack];
      }
      return await new Promise<TestTrack[]>((resolve) => {
        resolveBackground = (tracks) => {
          backgroundResolved = true;
          resolve(tracks);
        };
      });
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${track.title}:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${tracks.map((track) => track.title).join(',')}:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls);
  ctx.args = ['https://www.youtube.com/playlist?list=demo'];

  await execute(ctx);

  assert.deepEqual(playerCalls, [
    'previewTracks:1',
    'createTrackFromData:Track 1:user-1',
    'enqueue:Track 1:{"playNext":false,"dedupe":false}',
    'play',
    'previewTracks:25',
  ]);
  assert.equal(backgroundResolved, false);
  assert.ok(calls.some((entry) => entry.includes('Loading remaining playlist tracks in the background')));

  const finishBackground = resolveBackground as ((tracks: TestTrack[]) => void) | null;
  if (typeof finishBackground === 'function') {
    finishBackground([firstTrack, secondTrack]);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(backgroundResolved);
  assert.deepEqual(playerCalls, [
    'previewTracks:1',
    'createTrackFromData:Track 1:user-1',
    'enqueue:Track 1:{"playNext":false,"dedupe":false}',
    'play',
    'previewTracks:25',
    'createTrackFromData:Track 2:user-1',
    'enqueue:Track 2:{"playNext":false,"dedupe":false}',
  ]);
  assert.ok(calls.some((entry) => entry.includes('Queued **2/2** playlist tracks.')));
});

test('play keeps playlist background status in queued mode when a normal track is already playing', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let resolveBackground: ((tracks: TestTrack[]) => void) | null = null;

  const firstTrack = {
    title: 'Track 1',
    duration: '03:00',
    url: 'https://example.com/track-1',
    source: 'youtube-playlist',
  };
  const secondTrack = {
    title: 'Track 2',
    duration: '03:30',
    url: 'https://example.com/track-2',
    source: 'youtube-playlist',
  };

  const ctx = createBaseContext({
    playing: true,
    currentTrack: {
      title: 'Current Song',
      duration: '04:00',
      url: 'https://example.com/current',
      source: 'youtube',
      isLive: false,
    },
    async previewTracks(_query: string, options?: { limit?: number }) {
      playerCalls.push(`previewTracks:${options?.limit ?? 'full'}`);
      if (options?.limit === 1) {
        return [firstTrack];
      }
      return await new Promise<TestTrack[]>((resolve) => {
        resolveBackground = resolve;
      });
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${track.title}:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${tracks.map((track) => track.title).join(',')}:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls);
  ctx.args = ['https://music.apple.com/us/playlist/classic-punk-essentials/pl.878b36908fda455c8dd2cb0b5ef7ef0e'];

  await execute(ctx);

  assert.deepEqual(playerCalls, [
    'previewTracks:1',
    'createTrackFromData:Track 1:user-1',
    'enqueue:Track 1:{"playNext":false,"dedupe":false}',
    'previewTracks:25',
  ]);
  assert.ok(calls.some((entry) => entry.includes('Added to queue: **Track 1**') && entry.includes('Loading remaining playlist tracks in the background...')));
  assert.ok(!calls.some((entry) => entry.includes('Playing now: **Track 1**')));

  const finishBackground = resolveBackground as ((tracks: TestTrack[]) => void) | null;
  if (typeof finishBackground === 'function') {
    finishBackground([firstTrack, secondTrack]);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.some((entry) => entry.includes('Added to queue: **Track 1**') && entry.includes('Queued **2/2** playlist tracks.')));
  assert.ok(!calls.some((entry) => entry.includes('Playing now: **Track 1**') && entry.includes('Queued **2/2** playlist tracks.')));
});

test('play does not double-count the first playlist track when background metadata differs', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);
  const calls: string[] = [];
  const playerCalls: string[] = [];
  let resolveBackground: ((tracks: TestTrack[]) => void) | null = null;

  const firstPreviewTrack: TestTrack = {
    title: 'Track 1',
    duration: '3:00',
    url: 'https://www.youtube.com/watch?v=track1',
    source: 'youtube-playlist',
  };
  const firstResolvedTrack: TestTrack = {
    title: 'Track 1 (resolved)',
    duration: '3:00',
    url: 'https://www.youtube.com/watch?v=track1&list=demo',
    source: 'youtube-playlist',
  };
  const secondTrack: TestTrack = {
    title: 'Track 2',
    duration: '3:10',
    url: 'https://www.youtube.com/watch?v=track2',
    source: 'youtube-playlist',
  };

  const ctx = createBaseContext({
    playing: false,
    async previewTracks(_query: string, options?: { limit?: number }) {
      playerCalls.push(`previewTracks:${options?.limit ?? 'full'}`);
      if (options?.limit === 1) {
        return [firstPreviewTrack];
      }
      return await new Promise<TestTrack[]>((resolve) => {
        resolveBackground = resolve;
      });
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${track.title}:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${tracks.map((track) => track.title).join(',')}:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls);
  ctx.args = ['https://www.youtube.com/playlist?list=demo'];

  await execute(ctx);

  const finishBackground = resolveBackground as ((tracks: TestTrack[]) => void) | null;
  if (typeof finishBackground === 'function') {
    finishBackground([firstResolvedTrack, secondTrack]);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(playerCalls, [
    'previewTracks:1',
    'createTrackFromData:Track 1:user-1',
    'enqueue:Track 1:{"playNext":false,"dedupe":false}',
    'play',
    'previewTracks:25',
    'createTrackFromData:Track 2:user-1',
    'enqueue:Track 2:{"playNext":false,"dedupe":false}',
  ]);
  assert.ok(calls.some((entry) => entry.includes('Queued **2/2** playlist tracks.')));
  assert.ok(!calls.some((entry) => entry.includes('Queued **3/2** playlist tracks.')));
});

test('play starts voice connect and track preview in parallel', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let resolveConnect: (() => void) | null = null;
  let resolvePreview: ((tracks: TestTrack[]) => void) | null = null;

  const resolvedTrack = {
    title: 'Fast Start',
    duration: '03:05',
    url: 'https://example.com/fast-start',
    source: 'youtube',
  };

  const ctx = createBaseContext({
    playing: false,
    async previewTracks() {
      playerCalls.push('preview:start');
      return await new Promise<TestTrack[]>((resolve) => {
        resolvePreview = (tracks) => {
          playerCalls.push('preview:end');
          resolve(tracks);
        };
      });
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${requestedBy}`);
      return { ...track, requestedBy };
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls, {
    connection: {
      connected: false,
      async connect(channelId: string) {
        calls.push(`connect:start:${channelId}`);
        await new Promise<void>((resolve) => {
          resolveConnect = () => {
            calls.push(`connect:end:${channelId}`);
            resolve();
          };
        });
      },
      hasUsablePlayer() {
        return true;
      },
    },
  });

  const execution = execute(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.includes('connect:start:voice-1'));
  assert.ok(playerCalls.includes('preview:start'));
  assert.equal(calls.includes('connect:end:voice-1'), false);
  assert.equal(playerCalls.includes('preview:end'), false);

  const finishPreview = resolvePreview as ((tracks: TestTrack[]) => void) | null;
  const finishConnect = resolveConnect as (() => void) | null;
  assert.ok(finishPreview);
  assert.ok(finishConnect);

  finishPreview?.([resolvedTrack]);
  finishConnect?.();

  await execution;

  assert.deepEqual(playerCalls, [
    'preview:start',
    'preview:end',
    'createTrackFromData:user-1',
    'enqueue:{"playNext":false,"dedupe":false}',
    'play',
  ]);
});

test('play prefetches the first track for immediate startup while voice connect is still pending', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let resolveConnect: (() => void) | null = null;
  let resolvePrefetch: (() => void) | null = null;

  const resolvedTrack = {
    title: 'Warm Start',
    duration: '03:05',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    source: 'youtube',
  };

  const ctx = createBaseContext({
    playing: false,
    async previewTracks() {
      playerCalls.push('preview');
      return [resolvedTrack];
    },
    createTrackFromData(track: TestTrack, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${requestedBy}`);
      return { ...track, requestedBy };
    },
    async prefetchTrackPlayback(track: TestTrack) {
      playerCalls.push(`prefetch:start:${track.title}`);
      await new Promise<void>((resolve) => {
        resolvePrefetch = () => {
          playerCalls.push(`prefetch:end:${track.title}`);
          resolve();
        };
      });
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls, {
    connection: {
      connected: false,
      async connect(channelId: string) {
        calls.push(`connect:start:${channelId}`);
        await new Promise<void>((resolve) => {
          resolveConnect = () => {
            calls.push(`connect:end:${channelId}`);
            resolve();
          };
        });
      },
      hasUsablePlayer() {
        return true;
      },
    },
  });

  const execution = execute(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.includes('connect:start:voice-1'));
  assert.ok(playerCalls.includes('preview'));
  assert.ok(playerCalls.includes('prefetch:start:Warm Start'));
  assert.equal(calls.includes('connect:end:voice-1'), false);

  const finishPrefetch = resolvePrefetch as (() => void) | null;
  const finishConnect = resolveConnect as (() => void) | null;
  assert.ok(finishPrefetch);
  assert.ok(finishConnect);

  finishPrefetch?.();
  finishConnect?.();

  await execution;

  assert.deepEqual(playerCalls, [
    'preview',
    'createTrackFromData:user-1',
    'prefetch:start:Warm Start',
    'prefetch:end:Warm Start',
    'enqueue:{"playNext":false,"dedupe":false}',
    'play',
  ]);
});

test('play uses fast direct YouTube metadata when hydration resolves before the startup grace window', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let createdTrack: (TestTrack & { metadataDeferred?: boolean }) | null = null;

  const ctx = createBaseContext({
    playing: false,
    async previewTracks() {
      playerCalls.push('previewTracks');
      return [];
    },
    async hydrateTrackMetadata(track: TestTrack, options?: { requestedBy?: string | null }) {
      playerCalls.push(`hydrate:${track.title}:${options?.requestedBy ?? 'unknown'}`);
      return {
        ...track,
        title: 'Hydrated YouTube Title',
        duration: '03:33',
      };
    },
    createTrackFromData(track: TestTrack & { metadataDeferred?: boolean }, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${track.title}:${requestedBy}`);
      createdTrack = { ...track, requestedBy };
      return createdTrack;
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls);
  ctx.args = ['https://www.youtube.com/watch?v=abcdefghijk'];

  await execute(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(playerCalls.includes('previewTracks'), false);
  assert.ok(playerCalls.includes('createTrackFromData:Hydrated YouTube Title:user-1'));
  assert.ok(playerCalls.includes('play'));
  assert.ok(playerCalls.includes('hydrate:YouTube Track:user-1'));
  assert.ok(calls.some((entry) => entry.includes('Added to queue: **Hydrated YouTube Title**')));
  assert.ok(createdTrack);
  const hydratedTrack = createdTrack as TestTrack;
  assert.equal(hydratedTrack.title, 'Hydrated YouTube Title');
  assert.equal(hydratedTrack.duration, '03:33');
});

test('play falls back to placeholder for direct YouTube URLs and hydrates the queued track in the background when metadata is slow', async () => {
  const play = buildPlayCommand();
  const execute = play?.execute as PlayExecute | undefined;
  assert.ok(execute);

  const calls: string[] = [];
  const playerCalls: string[] = [];
  let createdTrack: (TestTrack & { metadataDeferred?: boolean }) | null = null;
  let resolveHydration: (() => void) | null = null;

  const ctx = createBaseContext({
    playing: false,
    async previewTracks() {
      playerCalls.push('previewTracks');
      return [];
    },
    async hydrateTrackMetadata(track: TestTrack, options?: { requestedBy?: string | null }) {
      playerCalls.push(`hydrate:start:${track.title}:${options?.requestedBy ?? 'unknown'}`);
      await new Promise<void>((resolve) => {
        resolveHydration = resolve;
      });
      playerCalls.push(`hydrate:end:${track.title}:${options?.requestedBy ?? 'unknown'}`);
      return {
        ...track,
        title: 'Hydrated Later',
        duration: '04:04',
      };
    },
    createTrackFromData(track: TestTrack & { metadataDeferred?: boolean }, requestedBy: string) {
      playerCalls.push(`createTrackFromData:${track.title}:${requestedBy}`);
      createdTrack = { ...track, requestedBy };
      return createdTrack;
    },
    enqueueResolvedTracks(tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) {
      playerCalls.push(`enqueue:${JSON.stringify({ playNext: options.playNext, dedupe: options.dedupe })}`);
      return tracks;
    },
    async play() {
      playerCalls.push('play');
    },
    skip() {
      playerCalls.push('skip');
      return true;
    },
  }, calls);
  ctx.args = ['https://www.youtube.com/watch?v=lmnopqrstuv'];

  await execute(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(playerCalls.includes('previewTracks'), false);
  assert.ok(playerCalls.includes('createTrackFromData:YouTube Track:user-1'));
  assert.ok(playerCalls.includes('play'));
  assert.ok(playerCalls.includes('hydrate:start:YouTube Track:user-1'));
  assert.ok(createdTrack);
  assert.equal((createdTrack as TestTrack).title, 'YouTube Track');
  assert.equal((createdTrack as TestTrack).duration, 'Unknown');
  assert.ok(calls.some((entry) => entry.includes('Starting playback and resolving track metadata...')));
  assert.ok(!calls.some((entry) => entry.includes('Added to queue: **YouTube Track** (Unknown)')));

  assert.ok(resolveHydration);
  const finishHydration = resolveHydration as () => void;
  finishHydration();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(playerCalls.includes('hydrate:end:YouTube Track:user-1'));
  assert.equal((createdTrack as TestTrack).title, 'Hydrated Later');
  assert.equal((createdTrack as TestTrack).duration, '04:04');
  assert.ok(calls.some((entry) => entry.includes('Added to queue: **Hydrated Later** (04:04)')));
});





