import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { createTranslator } from '../src/i18n/index.ts';
import { clearGlobalGuildAndUserCountsCache } from '../src/bot/commands/commandHelpers.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;
type Field = { name: string; value: string };

type ShardTotalsStub = { shardCount: number; guildCount: number; memberCount: number; uncountedGuildCount: number } | null;

type StatsEmbed = { fields?: Field[]; footer?: { text?: string } };
type ShardTotalsFull = NonNullable<ShardTotalsStub> & { playingCount?: number | null; listenerCount?: number | null };

async function runStats(
  config: Record<string, unknown>,
  guildCount: number | null,
  options: {
    shardTotals?: ShardTotalsFull | null;
    guildList?: unknown[];
    sessions?: Map<string, unknown>;
    listenersPerChannel?: number;
    latencyMs?: number | null;
  } = {},
) {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const execute = registry.resolve('stats')?.execute as Execute | undefined;
  assert.ok(execute);

  const edits: StatsEmbed[] = [];
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
    startedAt: Date.UTC(2026, 10, 7, 12, 0, 0),
    botUserId: 'bot-1',
    sessions: { sessions: options.sessions ?? new Map([['a', {}], ['b', {}]]) },
    voiceStateStore: {
      countUsersInChannel: () => options.listenersPerChannel ?? 0,
    },
    gateway: { getHeartbeatLatencyMs: () => options.latencyMs ?? null },
    guildStateCache: guildCount == null ? null : { guildCount: () => guildCount },
    shardTotals: 'shardTotals' in options ? async () => options.shardTotals ?? null : null,
    library: { getTotalPlays: async () => 42 },
    rest: {
      listCurrentUserGuilds: async () => options.guildList ?? [],
      sendMessage: async () => ({ id: 'progress-1' }),
      editMessage: async (_channelId: string, _messageId: string, payload: { embeds?: StatsEmbed[] }) => {
        edits.push(payload.embeds?.[0] ?? {});
        return { id: 'progress-1' };
      },
    },
    reply: { info: noop, success: noop, warning: noop, error: noop },
    sendPaginated: noop,
  } as never);

  const embed = edits.at(-1) ?? {};
  const fields = Object.fromEntries((embed.fields ?? []).map((field) => [field.name, field.value]));
  return { fields, footer: embed.footer?.text ?? '' };
}

const playing = (guildId: string, channelId: string) => ({
  guildId,
  connection: { channelId },
  player: { playing: true },
});

test('stats show when the bot started as a relative timestamp', async () => {
  const { fields } = await runStats({}, 1234);
  assert.equal(fields.Started, `<t:${Date.UTC(2026, 10, 7, 12, 0, 0) / 1000}:R>`);
  assert.equal('Uptime' in fields, false);
});

test('the footer carries version, shard, ping and memory instead of separate fields', async () => {
  const { fields, footer } = await runStats({ shardId: 1, shardCount: 2 }, 1234, { latencyMs: 41.6 });
  assert.match(footer, /^Vinto \| v\d+\.\d+\.\d+ \| Shard 2 of 2 \| Ping 42 ms \| \d+ MB heap$/);
  assert.equal('Shard' in fields, false);
  assert.equal('Heap Used' in fields, false);
});

test('an unsharded bot leaves the shard out of the footer', async () => {
  const { footer } = await runStats({}, 1234);
  assert.doesNotMatch(footer, /Shard/);
  assert.doesNotMatch(footer, /Ping/);
});

test('playing sessions and listeners are counted locally without registry totals', async () => {
  const sessions = new Map<string, unknown>([
    ['a', playing('g1', 'v1')],
    ['b', playing('g2', 'v2')],
    ['c', { guildId: 'g3', connection: { channelId: 'v3' }, player: { playing: false } }],
  ]);
  const { fields } = await runStats({}, 1234, { sessions, listenersPerChannel: 3 });
  assert.equal(fields['Playing now'], '2');
  assert.equal(fields.Listeners, '6');
});

test('playing sessions and listeners come from the registry when every shard reported', async () => {
  const { fields } = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: {
      shardCount: 2, guildCount: 1977, memberCount: 250_000, uncountedGuildCount: 0, playingCount: 41, listenerCount: 91,
    },
  });
  assert.equal(fields['Playing now'], '41');
  assert.equal(fields.Listeners, '91');
});

test('stats take guild and member totals from the shard registry when every shard reported', async () => {
  const { fields } = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: { shardCount: 2, guildCount: 1977, memberCount: 250_000, uncountedGuildCount: 0 },
    guildList: [{ id: '1', approximate_member_count: 5 }],
  });
  assert.equal(fields.Communities, '1,977');
  assert.equal(fields.Users, '250,000');
});

test('stats mark the member total as partial when a shard has guilds without a count', async () => {
  const { fields } = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: { shardCount: 2, guildCount: 10, memberCount: 40, uncountedGuildCount: 1 },
  });
  assert.equal(fields.Users, '40 (partial)');
});

test('stats fall back to the guild list counts when the registry has no totals', async () => {
  clearGlobalGuildAndUserCountsCache();
  const { fields } = await runStats({ shardId: 0, shardCount: 2 }, 900, {
    shardTotals: null,
    guildList: [
      { id: '1', approximate_member_count: 5 },
      { id: '2', approximate_member_count: 7 },
    ],
  });
  assert.equal(fields.Communities, '2');
  assert.equal(fields.Users, '12');
});
