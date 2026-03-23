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
  enqueueResolvedTracks?: (tracks: TestTrack[], options: { playNext?: boolean; dedupe?: boolean }) => TestTrack[];
  skip?: () => boolean;
  play?: () => Promise<void>;
};

function createBaseContext(sessionPlayer: SessionPlayer, calls: string[]) {
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
          connection: {
            connected: true,
          },
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





