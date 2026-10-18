import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { createTranslator } from '../src/i18n/index.ts';
import { clearGlobalGuildAndUserCountsCache } from '../src/bot/commands/commandHelpers.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;
type Field = { name: string; value: string };

type ShardTotalsStub = { shardCount: number; guildCount: number; memberCount: number; uncountedGuildCount: number } | null;

async function runStats(
  config: Record<string, unknown>,
  guildCount: number | null,
  options: { shardTotals?: ShardTotalsStub; guildList?: unknown[] } = {},
) {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const execute = registry.resolve('stats')?.execute as Execute | undefined;
  assert.ok(execute);

  const edits: Field[][] = [];
  const noop = async () => undefined;
  await execute({
    guildId: '1474874137937518680',
    channelId: 'text-1',
    authorId: '123456',
    args: [],
    prefix: '!',
    config: { prefix: '!', enableEmbeds: true, ...config },
    message: { id: 'command-1' },
    t: createTranslator('en'),
    startedAt: Date.now() - 60_000,
    sessions: { sessions: new Map([['a', {}], ['b', {}]]) },
    guildStateCache: guildCount == null ? null : { guildCount: () => guildCount },
    shardTotals: 'shardTotals' in options ? async () => options.shardTotals ?? null : null,
    library: { getTotalPlays: async () => 42 },
    rest: {
      listCurrentUserGuilds: async () => options.guildList ?? [],
      sendMessage: async () => ({ id: 'progress-1' }),
      editMessage: async (_channelId: string, _messageId: string, payload: { embeds?: Array<{ fields?: Field[] }> }) => {
        edits.push(payload.embeds?.[0]?.fields ?? []);
        return { id: 'progress-1' };
      },
    },
    reply: { info: noop, success: noop, warning: noop, error: noop },
    sendPaginated: noop,
  } as never);

  const fields = edits.at(-1) ?? [];
  return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

test('stats name the shard, its guild count and its sessions when the bot is sharded', async () => {
  const fields = await runStats({ shardId: 1, shardCount: 2 }, 1234);
  assert.equal(fields.Shard, '2 of 2');
  assert.equal(fields['Guilds on this shard'], '1234');
  assert.equal(fields['Sessions on this shard'], '2');
  assert.ok('Guilds total' in fields);
  assert.equal('Guild sessions' in fields, false);
});

test('an unsharded bot shows shard 1 of 1 without a per shard guild count', async () => {
  const fields = await runStats({}, 1234);
  assert.equal(fields.Shard, '1 of 1');
  assert.equal('Guilds on this shard' in fields, false);
  assert.equal(fields['Guild sessions'], '2');
});

test('stats take guild and member totals from the shard registry when every shard reported', async () => {
  const fields = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: { shardCount: 2, guildCount: 1977, memberCount: 250_000, uncountedGuildCount: 0 },
    guildList: [{ id: '1', approximate_member_count: 5 }],
  });
  assert.equal(fields['Guilds total'], '1977');
  assert.equal(fields['Users total'], '250000');
});

test('stats mark the member total as partial when a shard has guilds without a count', async () => {
  const fields = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: { shardCount: 2, guildCount: 10, memberCount: 40, uncountedGuildCount: 1 },
  });
  assert.equal(fields['Users total'], '40 (partial)');
});

test('stats fall back to the guild list counts when the registry has no totals', async () => {
  clearGlobalGuildAndUserCountsCache();
  const fields = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: null,
    guildList: [
      { id: '1', approximate_member_count: 5 },
      { id: '2', approximate_member_count: 7 },
    ],
  });
  assert.equal(fields['Guilds total'], '2');
  assert.equal(fields['Users total'], '12');
});
