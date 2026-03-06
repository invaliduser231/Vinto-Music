function parseNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function readMemberCountFromGuildLike(value) {
  if (!value || typeof value !== 'object') return null;

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

  const containers = [value, value.counts, value.guild_counts, value.guildCounts, value.stats, value.metrics];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of memberCountKeys) {
      const parsed = parseNonNegativeInteger(container[key]);
      if (parsed != null) return parsed;
    }
  }

  return null;
}

function readGuildMemberUserId(member) {
  if (!member || typeof member !== 'object') return null;
  const candidates = [
    member.user?.id,
    member.user_id,
    member.id,
    member.member?.user?.id,
    member.member?.user_id,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim();
    if (normalized) return normalized;
  }
  return null;
}

async function countGuildMembersByPagination(rest, guildId) {
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

export async function fetchGlobalGuildAndUserCounts(rest) {
  if (!rest?.listCurrentUserGuilds) {
    return { guildCount: null, userCount: null, incompleteGuildCount: 0 };
  }

  const guilds = [];
  let before = null;

  for (let page = 0; page < 100; page += 1) {
    const chunk = await rest.listCurrentUserGuilds({ limit: 200, before, withCounts: true }).catch(() => null);
    if (!Array.isArray(chunk) || !chunk.length) break;
    guilds.push(...chunk);
    if (chunk.length < 200) break;

    const lastId = chunk[chunk.length - 1]?.id;
    if (!lastId) break;
    before = String(lastId);
  }

  const guildById = new Map();
  for (const guild of guilds) {
    const guildId = String(guild?.id ?? '').trim();
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
    const guildId = String(guild?.id ?? '').trim();
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
