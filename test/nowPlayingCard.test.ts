import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNowPlayingCardFile,
  cleanDisplayArtist,
  cleanDisplayTitle,
  isLetterboxedThumbnail,
  isCardEnabled,
} from '../src/bot/cards/cardService.ts';
import { canRenderCardText, renderNowPlayingCard } from '../src/bot/cards/nowPlayingCard.ts';
import { CommandRouter } from '../src/bot/commandRouter.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

test('display titles drop video noise and a repeated artist prefix', () => {
  assert.equal(
    cleanDisplayTitle('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley'),
    'Never Gonna Give You Up',
  );
  assert.equal(cleanDisplayTitle('Song [Official Audio]', null), 'Song');
  assert.equal(cleanDisplayTitle('Live (Remix)', 'Someone'), 'Live (Remix)');
  assert.equal(cleanDisplayArtist('Tame Impala - Topic'), 'Tame Impala');
  assert.equal(cleanDisplayArtist('RickAstleyVEVO'), 'RickAstley');
});

test('the guild card switch overrides the default only when set', () => {
  assert.equal(isCardEnabled('on', false), true);
  assert.equal(isCardEnabled('OFF', true), false);
  assert.equal(isCardEnabled(null, true), true);
  assert.equal(isCardEnabled('ambient', false), false);
});

test('youtube default thumbnails are treated as letterboxed', () => {
  assert.equal(isLetterboxedThumbnail('https://i.ytimg.com/vi/abc/hqdefault.jpg'), true);
  assert.equal(isLetterboxedThumbnail('https://i.ytimg.com/vi/abc/maxresdefault.jpg'), false);
  assert.equal(isLetterboxedThumbnail('https://cdn-images.dzcdn.net/images/cover/x/1000x1000.jpg'), false);
});

test('text the bundled font cannot draw is detected', () => {
  assert.equal(canRenderCardText('Glatteis', 'Nina Chuba', 'Ça va déjà'), true);
  assert.equal(canRenderCardText('夜に駆ける'), false);
});

test('the card renders a png without a cover', async () => {
  const png = await renderNowPlayingCard({
    title: 'Glatteis',
    artist: 'Nina Chuba',
    durationSec: 170,
    positionSec: 30,
    sourceLabel: 'Deezer',
    upNext: 'Ok Kid - Alleine',
    queueLength: 3,
  });
  assert.ok(png);
  assert.deepEqual([...png!.subarray(0, 4)], PNG_SIGNATURE);
});

test('buildNowPlayingCardFile skips titles the font cannot draw', async () => {
  assert.equal(await buildNowPlayingCardFile({ title: '夜に駆ける', artist: 'YOASOBI' }, {}), null);
  const file = await buildNowPlayingCardFile({ title: 'Song', artist: 'Artist', duration: '3:00' }, {});
  assert.equal(file?.contentType, 'image/png');
});

function createRouter(sendFile: ((...args: unknown[]) => Promise<unknown>) | null) {
  const files: unknown[][] = [];
  const messages: unknown[] = [];
  const deleted: string[] = [];
  const router = new CommandRouter({
    config: { prefix: '!', sessionIdleMs: 300_000, enableEmbeds: true, nowPlayingCardEnabled: true },
    rest: {
      async sendTyping() {},
      async editMessage() { return {}; },
      async sendMessage(_channelId: string, payload: unknown) {
        messages.push(payload);
        return { id: `embed-${messages.length}` };
      },
      async deleteMessage(_channelId: string, messageId: string) {
        deleted.push(messageId);
      },
      ...(sendFile ? {
        async sendFile(...args: unknown[]) {
          files.push(args);
          return sendFile(...args);
        },
      } : {}),
    },
    gateway: {},
    sessions: {
      has: () => true,
      bindTextChannel: () => null,
      get: () => null,
      destroy: async () => null,
      on: () => null,
      sessions: new Map(),
    },
    voiceStateStore: { countUsersInChannel: () => 1 },
    lyrics: null,
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);
  return { router, files, messages, deleted };
}

const session = {
  guildId: '1000001',
  sessionId: '1000001:2000002',
  settings: {},
  connection: { channelId: '2000002' },
  player: { pendingTracks: [{ title: 'Next Song', artist: 'Next Artist' }] },
};

const track = { title: 'Glatteis', artist: 'Nina Chuba', duration: '2:50', source: 'deezer', requestedBy: '3000003' };

test('track start posts a card and replaces the previous one', async () => {
  let counter = 0;
  const { router, files, messages, deleted } = createRouter(async () => ({ id: `card-${++counter}` }));
  const t = (key: string) => key;

  assert.equal(await router._publishNowPlaying(session, track, '4000004', '', t as never), true);
  assert.equal(await router._publishNowPlaying(session, track, '4000004', '', t as never), true);

  assert.equal(files.length, 2);
  assert.equal(messages.length, 0);
  assert.deepEqual(deleted, ['card-1']);
  const payload = files[0]![2] as { content: string };
  assert.match(payload.content, /^-# /);
});

test('track start falls back to the embed when the upload fails', async () => {
  const { router, messages } = createRouter(async () => {
    throw new Error('upload rejected');
  });

  assert.equal(await router._publishNowPlaying(session, track, '4000004', '', ((key: string) => key) as never), true);
  assert.equal(messages.length, 1);
});
