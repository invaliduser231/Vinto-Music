import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';

function setupNowCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return registry.resolve('now');
}

test('now command shows simplified radio embed fields', async () => {
  const command = setupNowCommand();
  const sentPayloads = [];
  const originalDetect = global.fetch;

  global.fetch = async () => ({
    ok: true,
    headers: new Headers({
      'icy-metaint': '16000',
    }),
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            const encoder = new TextEncoder();
            const audio = new Uint8Array(16000);
            const meta = encoder.encode("StreamTitle='Artist Demo - Song Demo';");
            const padded = new Uint8Array(1 + 16 * 3);
            padded[0] = 3;
            padded.set(meta, 1);
            const combined = new Uint8Array(audio.length + padded.length);
            combined.set(audio, 0);
            combined.set(padded, audio.length);
            return { done: false, value: combined };
          },
          async cancel() {},
        };
      },
      async cancel() {},
    },
  });

  try {
    await command.execute({
      guildId: 'guild-1',
      channelId: 'channel-1',
      config: { enableEmbeds: true, auddApiToken: null },
      sessions: {
        get() {
          return {
            player: {
              displayTrack: {
                title: 'Demo Station Live',
                url: 'https://radio.example/stream',
                duration: 'Live',
                thumbnailUrl: 'https://example.com/radio.jpg',
                requestedBy: 'user-1',
                source: 'radio-stream',
              },
              currentTrack: null,
              getProgressSeconds() {
                return 125;
              },
            },
          };
        },
      },
      rest: {
        async sendMessage(_channelId, payload) {
          sentPayloads.push(payload);
          return { id: `msg-${sentPayloads.length}` };
        },
        async editMessage(_channelId, _messageId, payload) {
          sentPayloads.push(payload);
          return { id: 'msg-final' };
        },
      },
      reply: {
        async warning() {
          throw new Error('warning should not be called');
        },
      },
    });
  } finally {
    global.fetch = originalDetect;
  }

  const finalEmbed = sentPayloads.at(-1)?.embeds?.[0];
  assert.ok(finalEmbed);
  const fieldNames = finalEmbed.fields.map((field) => field.name);
  assert.deepEqual(fieldNames, ['Song', 'Progress', 'Station', 'Artist']);
  assert.equal(finalEmbed.description, undefined);
  assert.equal(finalEmbed.fields.find((field) => field.name === 'Station')?.value, '[Demo Station Live](https://radio.example/stream)');
  assert.equal(finalEmbed.fields.find((field) => field.name === 'Song')?.value, 'Song Demo');
  assert.equal(finalEmbed.fields.find((field) => field.name === 'Artist')?.value, 'Artist Demo');
  assert.equal(finalEmbed.footer?.text, 'Vinto | Radio recognition costs money to run. Support: https://ko-fi.com/Q5Q31VDH1Z');
});

test('now command omits source for standard tracks too', async () => {
  const command = setupNowCommand();
  const sentPayloads = [];

  await command.execute({
    guildId: 'guild-1',
    channelId: 'channel-1',
    config: { enableEmbeds: true },
    sessions: {
      get() {
        return {
          player: {
            displayTrack: {
              title: 'Wenn du tanzt',
              url: 'https://www.deezer.com/track/128548159',
              duration: '3:50',
              thumbnailUrl: 'https://example.com/cover.jpg',
              requestedBy: 'user-1',
              source: 'amazonmusic-deezer-search-direct',
            },
            currentTrack: null,
            loopMode: 'off',
            volumePercent: 100,
            pendingTracks: [],
            getProgressSeconds() {
              return 8;
            },
          },
        };
      },
    },
    rest: {
      async sendMessage(_channelId, payload) {
        sentPayloads.push(payload);
        return { id: 'msg-1' };
      },
    },
    reply: {
      async warning() {
        throw new Error('warning should not be called');
      },
    },
  });

  const finalEmbed = sentPayloads.at(-1)?.embeds?.[0];
  assert.ok(finalEmbed);
  const fieldNames = finalEmbed.fields.map((field) => field.name);
  assert.deepEqual(fieldNames, ['Progress', 'Loop', 'Volume', 'Queued']);
  assert.equal(finalEmbed.fields.find((field) => field.name === 'Source'), undefined);
});
