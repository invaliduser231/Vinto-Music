import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.js';
import { CommandRegistry } from '../src/bot/commandRegistry.js';

function setupLyricsCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const command = registry.resolve('lyrics');
  return { registry, command };
}

test('lyrics command uses current track artist and title as fallback query', async () => {
  const { command } = setupLyricsCommand();
  let requestedQuery = null;
  let paginatedPayloads = null;

  await command.execute({
    args: [],
    guildId: 'guild-1',
    config: { enableEmbeds: true },
    sessions: {
      get() {
        return {
          player: {
            currentTrack: {
              title: 'Pazifik',
              artist: 'Nina Chuba',
            },
          },
        };
      },
    },
    lyrics: {
      async search(query) {
        requestedQuery = query;
        return {
          source: 'lrclib.net',
          lyrics: 'line 1\nline 2',
        };
      },
    },
    reply: {
      async warning() {},
    },
    async safeTyping() {},
    async sendPaginated(payloads) {
      paginatedPayloads = payloads;
    },
  });

  assert.equal(requestedQuery, 'Nina Chuba - Pazifik');
  assert.ok(Array.isArray(paginatedPayloads));
  assert.ok(paginatedPayloads.length >= 1);
  assert.match(String(paginatedPayloads[0]?.embeds?.[0]?.title ?? ''), /Nina Chuba - Pazifik/);
});
