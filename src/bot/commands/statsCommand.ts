import {
  createCommand,
  fetchGlobalGuildAndUserCounts,
  getCachedGlobalGuildAndUserCounts,
} from './commandHelpers.ts';
import { buildInfoPayload, createProgressReporter } from './responseUtils.ts';
import { relativeTimestamp } from '../fluxerMarkdown.ts';
import { collectListeningStats, type ListeningStats } from '../services/listeningStats.ts';
import { shardAssignmentFromConfig } from '../../core/sharding.ts';
import { getAppVersion } from '../../utils/appVersion.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { CommandContextLike } from './helpers/types.ts';
import type { ShardTotals } from '../services/shardRegistry.ts';

type StatsContext = CommandContextLike & {
  startedAt?: number;
  gateway?: { getHeartbeatLatencyMs?: () => number | null } | null;
};

type GuildAndUserCounts = { guildCount?: number | null; userCount?: number | null; incompleteGuildCount: number };

type ListeningSession = Parameters<typeof collectListeningStats>[0] extends Iterable<infer T> ? T : never;

function localListeningStats(ctx: StatsContext): ListeningStats {
  const sessions = (ctx.sessions as { sessions?: Map<string, ListeningSession> }).sessions;
  return collectListeningStats(
    sessions?.values() ?? [],
    (guildId, channelId, excluded) => ctx.voiceStateStore?.countUsersInChannel?.(guildId, channelId, excluded) ?? 0,
    ctx.botUserId ?? null,
  );
}

function formatCount(ctx: StatsContext, value: number | null | undefined): string {
  if (value == null) return ctx.t('common.notAvailable');
  return value.toLocaleString(ctx.t.locale);
}

function buildFooter(ctx: StatsContext): string {
  const { shardId, shardCount } = shardAssignmentFromConfig({
    shardId: ctx.config.shardId,
    shardCount: ctx.config.shardCount,
  });
  const version = getAppVersion();
  const pingMs = ctx.gateway?.getHeartbeatLatencyMs?.() ?? null;
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  return [
    version ? `v${version}` : null,
    shardCount > 1 ? ctx.t('stats.footerShard', { position: shardId + 1, count: shardCount }) : null,
    pingMs != null ? ctx.t('stats.footerPing', { ms: Math.round(pingMs) }) : null,
    ctx.t('stats.footerMemory', { mb: heapMb }),
  ].filter(Boolean).join(' | ');
}

export function registerStatsCommand(registry: CommandRegistry) {
  registry.register(createCommand({
    name: 'stats',
    description: 'Show bot statistics.',
    usage: 'stats',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as StatsContext;
      const t = typedCtx.t;
      const progress = await createProgressReporter(typedCtx, t('stats.collecting'), null, null, { replyReference: true });
      const library = typedCtx.library as { getTotalPlays?: () => Promise<number> } | null;
      const totalPlays = library?.getTotalPlays ? await library.getTotalPlays().catch(() => null) : null;
      const startedAt = typedCtx.startedAt ?? Date.now();

      const userLabel = (counts: GuildAndUserCounts | null) => {
        if (counts?.userCount == null) return t('common.notAvailable');
        const total = formatCount(typedCtx, counts.userCount);
        return counts.incompleteGuildCount > 0 ? t('stats.partial', { count: total }) : total;
      };

      const render = async (guilds: string, users: string, listening: ListeningStats) => {
        const fields = [
          { name: t('stats.communities'), value: guilds, inline: true },
          { name: t('stats.users'), value: users, inline: true },
          { name: t('stats.started'), value: relativeTimestamp(startedAt), inline: true },
          { name: t('stats.playing'), value: formatCount(typedCtx, listening.playingCount), inline: true },
          { name: t('stats.listeners'), value: formatCount(typedCtx, listening.listenerCount), inline: true },
          { name: t('stats.tracksPlayed'), value: formatCount(typedCtx, totalPlays), inline: true },
        ];
        const payload = buildInfoPayload(typedCtx, t('stats.title'), '', fields, { footer: buildFooter(typedCtx) });
        const replaced = await progress.replace(payload);
        if (!replaced) await progress.info(t('stats.title'), fields);
      };

      const local = localListeningStats(typedCtx);
      const shardTotals: ShardTotals | null = await (typedCtx.shardTotals?.() ?? Promise.resolve(null)).catch(() => null);
      if (shardTotals) {
        await render(
          formatCount(typedCtx, shardTotals.guildCount),
          userLabel({ userCount: shardTotals.memberCount, incompleteGuildCount: shardTotals.uncountedGuildCount }),
          {
            playingCount: shardTotals.playingCount ?? local.playingCount,
            listenerCount: shardTotals.listenerCount ?? local.listenerCount,
          },
        );
        return;
      }

      const cachedCounts = getCachedGlobalGuildAndUserCounts(typedCtx.rest);
      if (cachedCounts) {
        await render(formatCount(typedCtx, cachedCounts.guildCount), userLabel(cachedCounts), local);
        return;
      }

      await render(t('stats.counting'), t('stats.counting'), local);
      const globalCounts = await fetchGlobalGuildAndUserCounts(typedCtx.rest).catch(() => null);
      await render(formatCount(typedCtx, globalCounts?.guildCount), userLabel(globalCounts), local);
    },
  }));
}
