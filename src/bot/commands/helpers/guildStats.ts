import { asRecord } from '../../../utils/unknownData.ts';

const GUILD_PAGE_LIMIT = 200;
const MAX_GUILD_PAGES = 100;
const GLOBAL_COUNTS_CACHE_TTL_MS = 5 * 60 * 1000;
const MEMBER_COUNT_KEYS = ['approximate_member_count', 'member_count'] as const;

export type GuildStatsRestLike = {
  listCurrentUserGuilds?: (options: { limit: number; after?: string; withCounts?: boolean }) => Promise<unknown>;
};

export type GlobalGuildAndUserCounts = {
  guildCount: number | null;
  userCount: number | null;
  incompleteGuildCount: number;
};

let globalCountsCache:
  | { key: GuildStatsRestLike; expiresAt: number; value: GlobalGuildAndUserCounts }
  | null = null;

function readMemberCount(guild: Record<string, unknown>): number | null {
  for (const key of MEMBER_COUNT_KEYS) {
    const value = Number(guild[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

async function listCurrentUserGuilds(rest: GuildStatsRestLike, withCounts: boolean): Promise<Record<string, unknown>[]> {
  if (!rest.listCurrentUserGuilds) return [];

  const guildById = new Map<string, Record<string, unknown>>();
  let after: string | undefined;

  for (let page = 0; page < MAX_GUILD_PAGES; page += 1) {
    const chunk = await rest.listCurrentUserGuilds({
      limit: GUILD_PAGE_LIMIT,
      ...(after ? { after } : {}),
      ...(withCounts ? { withCounts: true } : {}),
    });
    if (!Array.isArray(chunk) || !chunk.length) break;

    for (const raw of chunk) {
      const guild = asRecord(raw);
      const guildId = String(guild?.id ?? '').trim();
      if (guild && guildId) guildById.set(guildId, guild);
    }
    if (chunk.length < GUILD_PAGE_LIMIT) break;

    const lastId = String(asRecord(chunk[chunk.length - 1])?.id ?? '').trim();
    if (!lastId || lastId === after) break;
    after = lastId;
  }

  return [...guildById.values()];
}

export function getCachedGlobalGuildAndUserCounts(rest: GuildStatsRestLike | null | undefined): GlobalGuildAndUserCounts | null {
  if (!rest || !globalCountsCache || globalCountsCache.key !== rest) return null;
  if (globalCountsCache.expiresAt <= Date.now()) {
    globalCountsCache = null;
    return null;
  }
  return { ...globalCountsCache.value };
}

export function clearGlobalGuildAndUserCountsCache(): void {
  globalCountsCache = null;
}

export async function fetchGlobalGuildAndUserCounts(rest: GuildStatsRestLike | null | undefined): Promise<GlobalGuildAndUserCounts> {
  if (!rest?.listCurrentUserGuilds) {
    return { guildCount: null, userCount: null, incompleteGuildCount: 0 };
  }

  const guilds = await listCurrentUserGuilds(rest, true);
  let userCount = 0;
  let incompleteGuildCount = 0;
  for (const guild of guilds) {
    const count = readMemberCount(guild);
    if (count == null) incompleteGuildCount += 1;
    else userCount += count;
  }

  const value = { guildCount: guilds.length, userCount, incompleteGuildCount };
  globalCountsCache = { key: rest, expiresAt: Date.now() + GLOBAL_COUNTS_CACHE_TTL_MS, value };
  return { ...value };
}

export async function fetchGlobalGuildCount(rest: GuildStatsRestLike | null | undefined): Promise<number | null> {
  if (!rest?.listCurrentUserGuilds) return null;
  const cached = getCachedGlobalGuildAndUserCounts(rest);
  if (cached?.guildCount != null) return cached.guildCount;
  const guilds = await listCurrentUserGuilds(rest, false);
  return guilds.length;
}
