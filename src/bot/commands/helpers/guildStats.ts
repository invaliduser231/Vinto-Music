function parseNonNegativeInteger(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

type LooseRecord = Record<string, unknown>;

function toRecord(value: unknown): LooseRecord | null {
  if (!value || typeof value !== 'object') return null;
  return value as LooseRecord;
}

function readMemberCountFromGuildLike(value: unknown) {
  const root = toRecord(value);
  if (!root) return null;

  const memberCountKeys = [
    'member_count',
    'members_count',
    'approximate_member_count',
    'approx_member_count',
    'memberCount',
    'membersCount',
    'approximateMemberCount',
    'approxMemberCount',
  ];

  const containers: Array<LooseRecord | null> = [
    root,
    toRecord(root.counts),
    toRecord(root.guild_counts),
    toRecord(root.guildCounts),
    toRecord(root.stats),
    toRecord(root.metrics),
  ];
  for (const container of containers) {
    if (!container) continue;
    for (const key of memberCountKeys) {
      const parsed = parseNonNegativeInteger(container[key]);
      if (parsed != null) return parsed;
    }
  }

  return null;
}

function readGuildMemberUserId(member: unknown) {
  const typed = toRecord(member);
  if (!typed) return null;
  const user = toRecord(typed.user);
  const nestedMember = toRecord(typed.member);
  const nestedUser = toRecord(nestedMember?.user);
  const candidates = [
    user?.id,
    typed.user_id,
    typed.id,
    nestedUser?.id,
    nestedMember?.user_id,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim();
    if (normalized) return normalized;
  }
  return null;
}

type GuildStatsRestLike = {
  listGuildMembers?: (guildId: string, options: { limit: number; after: string | null }) => Promise<unknown>;
  listCurrentUserGuilds?: (options: { limit: number; after: string | null; withCounts: true }) => Promise<unknown>;
  getGuild?: (guildId: string, options: { withCounts: true }) => Promise<unknown>;
};

async function countGuildMembersByPagination(rest: GuildStatsRestLike, guildId: string) {
  if (!rest?.listGuildMembers) return null;

  const PAGE_LIMIT = 1_000;
  let after = null;
  let total = 0;

  for (let page = 0; page < 5_000; page += 1) {
    const members = await rest.listGuildMembers(guildId, { limit: PAGE_LIMIT, after }).catch(() => null);
    if (!Array.isArray(members)) return null;
    if (members.length === 0) return total;

    total += members.length;
    if (members.length < PAGE_LIMIT) return total;

    const nextAfter = readGuildMemberUserId(members[members.length - 1]);
    if (!nextAfter || nextAfter === after) return null;
    after = nextAfter;
  }

  return null;
}

export async function fetchGlobalGuildAndUserCounts(rest: GuildStatsRestLike | null | undefined) {
  if (!rest?.listCurrentUserGuilds) {
    return { guildCount: null, userCount: null, incompleteGuildCount: 0 };
  }

  const guilds: unknown[] = [];
  let after = null;

  for (let page = 0; page < 100; page += 1) {
    const chunk = await rest.listCurrentUserGuilds({ limit: 200, after, withCounts: true }).catch(() => null) as unknown[] | null;
    if (!Array.isArray(chunk) || !chunk.length) break;

    guilds.push(...chunk);
    if (chunk.length < 200) break;

    const lastGuild = toRecord(chunk[chunk.length - 1]);
    const lastId: string | null = lastGuild?.id ? String(lastGuild.id) : null;
    if (!lastId) break;
    after = String(lastId);
  }

  const guildById = new Map();
  for (const guild of guilds) {
    const guildId = String(toRecord(guild)?.id ?? '').trim();
    if (guildId) guildById.set(guildId, guild);
  }
  const uniqueGuilds = [...guildById.values()];

  if (!uniqueGuilds.length) {
    return { guildCount: 0, userCount: 0, incompleteGuildCount: 0 };
  }

  if (!rest?.getGuild && !rest?.listGuildMembers) {
    let fallbackUserCount = 0;
    let fallbackIncompleteGuildCount = 0;
    for (const guild of uniqueGuilds) {
      const count = readMemberCountFromGuildLike(guild);
      if (count == null) fallbackIncompleteGuildCount += 1;
      else fallbackUserCount += count;
    }

    return {
      guildCount: uniqueGuilds.length,
      userCount: fallbackUserCount,
      incompleteGuildCount: fallbackIncompleteGuildCount,
    };
  }

  let userCount = 0;
  let incompleteGuildCount = 0;
  for (const guild of uniqueGuilds) {
    const guildId = String(toRecord(guild)?.id ?? '').trim();
    let count = guildId ? await countGuildMembersByPagination(rest, guildId) : null;

    if (count == null && guildId && rest?.getGuild) {
      const details = await rest.getGuild(guildId, { withCounts: true }).catch(() => null);
      count = readMemberCountFromGuildLike(details);
    }
    if (count == null) count = readMemberCountFromGuildLike(guild);

    if (count == null) incompleteGuildCount += 1;
    else userCount += count;
  }

  return {
    guildCount: uniqueGuilds.length,
    userCount,
    incompleteGuildCount: Math.max(0, incompleteGuildCount),
  };
}


