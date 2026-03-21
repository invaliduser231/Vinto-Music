import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

function setupLyricsCommand() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const command = registry.resolve('lyrics');
  return { registry, command };
}

test('lyrics command uses current track artist and title as fallback query', async () => {
  const { command } = setupLyricsCommand();
  assert.ok(command?.execute);
  let requestedQuery: string | null = null;
  let paginatedPayloads: Array<{ embeds?: Array<{ title?: string }> }> | null = null;

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
      async search(query: string) {
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
    async sendPaginated(payloads: Array<{ embeds?: Array<{ title?: string }> }>) {
      paginatedPayloads = payloads;
    },
  });

  const payloads = paginatedPayloads ?? [];
  const firstPayload = payloads[0] as { embeds?: Array<{ title?: string }> } | undefined;
  assert.equal(requestedQuery, 'Nina Chuba - Pazifik');
  assert.ok(Array.isArray(paginatedPayloads));
  assert.ok(payloads.length >= 1);
  assert.match(String(firstPayload?.embeds?.[0]?.title ?? ''), /Nina Chuba - Pazifik/);
});





