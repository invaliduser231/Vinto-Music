import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { createTranslator } from '../src/i18n/index.ts';

type Field = { name: string; value: string };

function createContext(options: { totalPlays?: number | null; slowCounts?: boolean } = {}) {
  const renders: Field[][] = [];

  const context = {
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: '100000000000000001',
    args: [] as string[],
    prefix: '!',
    startedAt: Date.now() - 60_000,
    config: { prefix: '!', enableEmbeds: true },
    message: { id: 'message-1' },
    t: createTranslator('en'),
    sessions: { sessions: new Map([['a', {}]]) },
    library: options.totalPlays === undefined
      ? null
      : {
        async getTotalPlays() {
          if (options.totalPlays === null) throw new Error('database down');
          return options.totalPlays;
        },
      },
    rest: {
      async sendMessage() {
        return { id: 'message-2' };
      },
      async editMessage(_channelId: string, _messageId: string, payload: { embeds?: Array<{ fields?: Field[] }> }) {
        renders.push(payload.embeds?.[0]?.fields ?? []);
      },
      async listCurrentUserGuilds() {
        if (options.slowCounts) await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    },
    reply: {
      async info() {},
      async success() {},
      async warning() {},
      async error() {},
    },
  };

  return { context, renders };
}

function runStats(context: unknown) {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const execute = registry.resolve('stats')?.execute;
  assert.ok(execute);
  return execute(context as never);
}

test('the play count is in the very first render, not only the final one', async () => {
  const { context, renders } = createContext({ totalPlays: 33147, slowCounts: true });

  await runStats(context);

  assert.ok(renders.length >= 1, 'the command rendered at least once');
  for (const [index, fields] of renders.entries()) {
    const played = fields.find((field) => field.name === 'Tracks played');
    assert.ok(played, `render ${index + 1} is missing the play count`);
    assert.equal(played?.value, '`33,147`');
  }
});

test('an unreachable database shows n/a instead of a wrong zero', async () => {
  const { context, renders } = createContext({ totalPlays: null });

  await runStats(context);

  const played = renders.at(-1)?.find((field) => field.name === 'Tracks played');
  assert.equal(played?.value, 'n/a');
});

test('without a library the play count still renders as n/a', async () => {
  const { context, renders } = createContext({});

  await runStats(context);

  const played = renders.at(-1)?.find((field) => field.name === 'Tracks played');
  assert.equal(played?.value, 'n/a');
});
