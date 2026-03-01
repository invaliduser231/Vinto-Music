import { ValidationError } from '../../core/errors.js';
import { applyMoodPreset } from './advancedCommands.js';
import { buildEmbed } from '../messageFormatter.js';

const VOICE_CHANNEL_PATTERN = /^<#(\d+)>$/;
const ROLE_MENTION_PATTERN = /^<@&(\d+)>$/;
const PENDING_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZE = 10;
const PLAYLIST_PAGE_SIZE = 10;
const FAVORITES_PAGE_SIZE = 10;
const SEARCH_RESULT_DEFAULT_LIMIT = 5;
const SUPPORT_SERVER_URL = 'https://fluxer.gg/qDoq4Tf0';
const PERMISSION_CACHE_TTL_MS = 60_000;
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const playCooldowns = new Map();
const pendingSearchSelections = new Map();
const manageGuildPermissionCache = new Map();
function parseVoiceChannelArgument(args) {
  if (!args?.length) return { channelId: null, rest: args ?? [] };

  const first = args[0];
  const mention = String(first).match(VOICE_CHANNEL_PATTERN);
  if (mention) {
    return { channelId: mention[1], rest: args.slice(1) };
  }

  if (/^\d{10,}$/.test(String(first))) {
    return { channelId: String(first), rest: args.slice(1) };
  }

  return { channelId: null, rest: args };
}

function trackLabel(track) {
  const by = track.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  return `**${track.title}** (${track.duration})${by}`;
}

function parseDurationToSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.toLowerCase() === 'unknown') return null;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part) && part >= 0)) return null;

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatUptimeCompact(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const secs = safe % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function buildProgressBar(positionSec, totalSec, size = 16) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return `${formatSeconds(positionSec)} • live/unknown`;
  }

  const clamped = Math.max(0, Math.min(positionSec, totalSec));
  const progress = clamped / totalSec;
  const marker = Math.min(size - 1, Math.max(0, Math.floor(progress * (size - 1))));

  const chars = [];
  for (let i = 0; i < size; i += 1) {
    chars.push(i === marker ? '●' : '━');
  }

  return `${formatSeconds(clamped)} ${chars.join('')} ${formatSeconds(totalSec)}`;
}

function sumTrackDurationsSeconds(tracks) {
  let total = 0;
  for (const track of tracks) {
    const parsed = parseDurationToSeconds(track?.duration);
    if (parsed == null) continue;
    total += parsed;
  }
  return total;
}

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

  const containers = [
    value,
    value.counts,
    value.guild_counts,
    value.guildCounts,
    value.stats,
    value.metrics,
  ];

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
    if (!normalized) continue;
    return normalized;
  }

  return null;
}

async function countGuildMembersByPagination(rest, guildId) {
  if (!rest?.listGuildMembers) return null;

  const PAGE_LIMIT = 1_000;
  const MAX_PAGES_PER_GUILD = 5_000;
  let after = null;
  let total = 0;

  for (let page = 0; page < MAX_PAGES_PER_GUILD; page += 1) {
    const members = await rest.listGuildMembers(guildId, {
      limit: PAGE_LIMIT,
      after,
    }).catch(() => null);

    if (!Array.isArray(members)) {
      return null;
    }

    if (members.length === 0) {
      return total;
    }

    total += members.length;

    if (members.length < PAGE_LIMIT) {
      return total;
    }

    const nextAfter = readGuildMemberUserId(members[members.length - 1]);
    if (!nextAfter || nextAfter === after) {
      return null;
    }
    after = nextAfter;
  }

  return null;
}

async function fetchGlobalGuildAndUserCounts(rest) {
  if (!rest?.listCurrentUserGuilds) {
    return {
      guildCount: null,
      userCount: null,
      incompleteGuildCount: 0,
    };
  }

  const guilds = [];
  let before = null;

  // Fetch all guild pages (Discord-like pagination with "before").
  for (let page = 0; page < 100; page += 1) {
    const chunk = await rest.listCurrentUserGuilds({
      limit: 200,
      before,
      withCounts: true,
    }).catch(() => null);
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
    if (!guildId) continue;
    guildById.set(guildId, guild);
  }
  const uniqueGuilds = [...guildById.values()];

  if (!uniqueGuilds.length) {
    return {
      guildCount: 0,
      userCount: 0,
      incompleteGuildCount: 0,
    };
  }

  if (!rest?.getGuild && !rest?.listGuildMembers) {
    let fallbackUserCount = 0;
    let fallbackIncompleteGuildCount = 0;
    for (const guild of uniqueGuilds) {
      const count = readMemberCountFromGuildLike(guild);
      if (count == null) {
        fallbackIncompleteGuildCount += 1;
      } else {
        fallbackUserCount += count;
      }
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
    let count = null;

    if (guildId) {
      count = await countGuildMembersByPagination(rest, guildId);
    }

    if (count == null && guildId && rest?.getGuild) {
      const details = await rest.getGuild(guildId, { withCounts: true }).catch(() => null);
      count = readMemberCountFromGuildLike(details);
    }

    if (count == null) {
      count = readMemberCountFromGuildLike(guild);
    }

    if (count == null) {
      incompleteGuildCount += 1;
    } else {
      userCount += count;
    }
  }

  return {
    guildCount: uniqueGuilds.length,
    userCount,
    incompleteGuildCount: Math.max(0, incompleteGuildCount),
  };
}

function ensureGuild(ctx) {
  if (!ctx.guildId) {
    throw new ValidationError('This command can only be used in a guild channel.');
  }
}

function getSessionOrThrow(ctx) {
  const session = ctx.sessions.get(ctx.guildId);
  if (!session) {
    throw new ValidationError('No active player in this guild.');
  }
  return session;
}

async function getGuildConfigOrThrow(ctx) {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  if (ctx.guildConfig && ctx.guildConfig.guildId === ctx.guildId) {
    return ctx.guildConfig;
  }

  const loaded = await ctx.guildConfigs.get(ctx.guildId);
  ctx.guildConfig = loaded;
  return loaded;
}

async function updateGuildConfig(ctx, patch) {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  const updated = await ctx.guildConfigs.update(ctx.guildId, patch);
  ctx.guildConfig = updated;
  ctx.sessions.applyGuildConfig(ctx.guildId, updated);
  return updated;
}

function getDjRoleSet(guildConfig) {
  const roleIds = guildConfig?.settings?.djRoleIds ?? [];
  return new Set(roleIds.map((roleId) => String(roleId)));
}

function extractVoiceStateFromMemberPayload(member) {
  if (!member || typeof member !== 'object') return null;

  const candidates = [
    member.voice_state,
    member.voiceState,
    member.voice,
    member?.member?.voice_state,
    member?.member?.voiceState,
    member?.member?.voice,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
  }

  return null;
}

function isVoiceStateDeafened(voiceState) {
  if (!voiceState || typeof voiceState !== 'object') return false;

  const flags = [
    voiceState.deaf,
    voiceState.self_deaf,
    voiceState.selfDeaf,
    voiceState.is_deafened,
    voiceState.isDeafened,
  ];

  return flags.some((value) => value === true);
}

async function isBotCurrentlyDeafened(ctx) {
  if (!ctx?.guildId || !ctx?.botUserId || typeof ctx?.rest?.getGuildMember !== 'function') {
    return false;
  }

  try {
    const botMember = await ctx.rest.getGuildMember(ctx.guildId, ctx.botUserId);
    const voiceState = extractVoiceStateFromMemberPayload(botMember);
    return isVoiceStateDeafened(voiceState);
  } catch {
    return false;
  }
}

async function ensureConnectedSession(ctx, explicitChannelId = null) {
  let resolvedVoice = explicitChannelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  if (!resolvedVoice && !explicitChannelId && ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback) {
    resolvedVoice = await ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback(
      ctx.message,
      ctx.rest,
      2_500
    );
  }
  if (!resolvedVoice) {
    const prefix = ctx.prefix ?? ctx.config.prefix;
    throw new ValidationError(
      `You are not in a voice channel. Use \`${prefix}play <#voice-channel> <query>\` as fallback.`
    );
  }

  if (ctx.permissionService) {
    const canVoice = await ctx.permissionService.canBotJoinAndSpeak(ctx.guildId, resolvedVoice);
    if (canVoice === false) {
      throw new ValidationError('I do not have permission to connect and speak in that voice channel.');
    }
  }

  if (await isBotCurrentlyDeafened(ctx)) {
    throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
  }

  const hadSession = ctx.sessions.has(ctx.guildId);
  const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig);
  ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId);

  const hasUsablePlayer = typeof session.connection?.hasUsablePlayer === 'function'
    ? session.connection.hasUsablePlayer()
    : true;
  if (session.connection.connected && hasUsablePlayer) return session;

  try {
    await session.connection.connect(resolvedVoice);
  } catch (err) {
    const shouldResetSession = (
      !hadSession
      || String(err?.message ?? '').toLowerCase().includes('already been destroyed')
    );

    if (shouldResetSession) {
      await ctx.sessions.destroy(ctx.guildId, 'connect_failed').catch(() => null);
    }
    if (await isBotCurrentlyDeafened(ctx)) {
      throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
    }
    throw err;
  }

  return session;
}

async function applyVoiceProfileIfConfigured(ctx, session, explicitChannelId = null) {
  if (!ctx.library?.getVoiceProfile) return;
  const channelId = explicitChannelId ?? session?.connection?.channelId ?? null;
  if (!channelId || !ctx.guildId) return;

  const profile = await ctx.library.getVoiceProfile(ctx.guildId, channelId).catch(() => null);
  const moodPreset = String(profile?.moodPreset ?? '').trim().toLowerCase();
  if (!moodPreset) return;

  applyMoodPreset(session.player, moodPreset);
}

async function resolveQueueGuard(ctx) {
  if (!ctx.library?.getGuildFeatureConfig || !ctx.guildId) return null;
  const cfg = await ctx.library.getGuildFeatureConfig(ctx.guildId).catch(() => null);
  return cfg?.queueGuard ?? null;
}

function formatQueuePage(session, page) {
  const pending = session.player.pendingTracks;
  const current = session.player.currentTrack;

  if (!current && pending.length === 0) {
    return {
      description: 'Queue is empty.',
      fields: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(pending.length / PENDING_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));

  const start = (safePage - 1) * PENDING_PAGE_SIZE;
  const pageItems = pending.slice(start, start + PENDING_PAGE_SIZE);

  const fields = [];

  if (current) {
    const durationSec = parseDurationToSeconds(current.duration);
    const progressSec = session.player.getProgressSeconds();
    fields.push({
      name: 'Now Playing',
      value: `${trackLabel(current)}\n${buildProgressBar(progressSec, durationSec ?? Number.NaN)}`.slice(0, 1000),
    });
  }

  if (pageItems.length) {
    const lines = pageItems.map((track, i) => {
      const idx = start + i + 1;
      return `${idx}. ${trackLabel(track)}`;
    });

    fields.push({
      name: `Up Next (Page ${safePage}/${totalPages})`,
      value: lines.join('\n').slice(0, 1000),
    });
  }

  const pendingDurationSec = sumTrackDurationsSeconds(pending);
  return {
    description: `Loop: **${session.player.loopMode}** • Volume: **${session.player.volumePercent}%** • Pending duration: **${formatSeconds(pendingDurationSec)}** • Autoplay: **disabled** • Dedupe: **${session.settings.dedupeEnabled ? 'on' : 'off'}** • 24/7: **${session.settings.stayInVoiceEnabled ? 'on' : 'off'}**`,
    fields,
  };
}

function formatHistoryPage(session, page) {
  const history = session.player.historyTracks;
  if (!history.length) {
    return {
      description: 'No playback history yet.',
      fields: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));

  const start = (safePage - 1) * HISTORY_PAGE_SIZE;
  const pageItems = history
    .slice()
    .reverse()
    .slice(start, start + HISTORY_PAGE_SIZE);

  return {
    description: `History page **${safePage}/${totalPages}** • Total tracks: **${history.length}**`,
    fields: [{
      name: 'Recently Played',
      value: pageItems
        .map((track, idx) => `${start + idx + 1}. ${trackLabel(track)}`)
        .join('\n')
        .slice(0, 1000),
    }],
  };
}

function parseRequiredInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${label} must be an integer.`);
  }
  return parsed;
}

function parseOnOff(value, fallback = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function enforcePlayCooldown(ctx) {
  const cooldownMs = Math.max(0, Number.parseInt(String(ctx.config.playCommandCooldownMs ?? 0), 10) || 0);
  if (cooldownMs <= 0) return;

  const userId = ctx.authorId ? String(ctx.authorId) : null;
  if (!userId) return;

  const guildPart = ctx.guildId ? String(ctx.guildId) : 'dm';
  const key = `${guildPart}:${userId}`;
  const now = Date.now();
  const last = playCooldowns.get(key) ?? 0;
  const remainingMs = cooldownMs - (now - last);
  if (remainingMs > 0) {
    const remainingSec = (remainingMs / 1000).toFixed(1);
    throw new ValidationError(`You are using play too quickly. Please wait ${remainingSec}s.`);
  }

  playCooldowns.set(key, now);

  if (playCooldowns.size > 10_000) {
    const staleBefore = now - Math.max(cooldownMs * 3, 60_000);
    for (const [entryKey, entryTs] of playCooldowns.entries()) {
      if (entryTs < staleBefore) {
        playCooldowns.delete(entryKey);
      }
    }
  }
}

function getMemberRoleIds(ctx) {
  const roles = ctx.message?.member?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.map((roleId) => String(roleId));
}

function parseRoleId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(ROLE_MENTION_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

function parseTextChannelId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(VOICE_CHANNEL_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

function normalizeIndex(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function requireLibrary(ctx) {
  if (!ctx.library) {
    throw new ValidationError('Music library storage is unavailable.');
  }
  return ctx.library;
}

function searchSelectionKey(ctx) {
  const guildId = String(ctx.guildId ?? '');
  const userId = String(ctx.authorId ?? '');
  return `${guildId}:${userId}`;
}

function saveSearchSelection(ctx, tracks) {
  const key = searchSelectionKey(ctx);
  const ttl = Math.max(5_000, Number.parseInt(String(ctx.config.searchPickTimeoutMs ?? 45_000), 10) || 45_000);
  const now = Date.now();

  pendingSearchSelections.set(key, {
    tracks,
    expiresAt: now + ttl,
  });

  if (pendingSearchSelections.size > 10_000) {
    for (const [entryKey, entry] of pendingSearchSelections.entries()) {
      if (entry.expiresAt <= now) {
        pendingSearchSelections.delete(entryKey);
      }
    }
  }

  return ttl;
}

function consumeSearchSelection(ctx) {
  const key = searchSelectionKey(ctx);
  const entry = pendingSearchSelections.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    pendingSearchSelections.delete(key);
    return null;
  }

  return entry.tracks;
}

function clearSearchSelection(ctx) {
  pendingSearchSelections.delete(searchSelectionKey(ctx));
}

function normalizePermissionName(name) {
  return String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function permissionNameToBit(name) {
  const normalized = normalizePermissionName(name);
  if (!normalized) return null;

  if (normalized === 'ADMINISTRATOR' || normalized === 'ADMIN') {
    return ADMINISTRATOR_PERMISSION;
  }

  if (
    normalized === 'MANAGE_GUILD'
    || normalized === 'MANAGE_SERVER'
    || normalized === 'SERVER_MANAGE'
    || normalized === 'MANAGE_GUILD_SETTINGS'
  ) {
    return MANAGE_GUILD_PERMISSION;
  }

  return null;
}

function extractPermissionBits(value, depth = 0) {
  if (depth > 4 || value == null) return null;

  if (typeof value === 'bigint') return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }

    const parts = trimmed.split(/[,\s|]+/).filter(Boolean);
    let bits = 0n;
    let matched = false;
    for (const part of parts) {
      const bit = permissionNameToBit(part);
      if (!bit) continue;
      bits |= bit;
      matched = true;
    }
    return matched ? bits : null;
  }

  if (Array.isArray(value)) {
    let bits = 0n;
    let matched = false;
    for (const item of value) {
      const fromItem = extractPermissionBits(item, depth + 1);
      if (fromItem == null) continue;
      bits |= fromItem;
      matched = true;
    }
    return matched ? bits : null;
  }

  if (typeof value === 'object') {
    if (value.permissions !== undefined && value.permissions !== value) {
      const nested = extractPermissionBits(value.permissions, depth + 1);
      if (nested != null) return nested;
    }

    if (value.bitfield !== undefined && value.bitfield !== value) {
      const nested = extractPermissionBits(value.bitfield, depth + 1);
      if (nested != null) return nested;
    }

    let bits = 0n;
    let matched = false;
    for (const [key, enabled] of Object.entries(value)) {
      if (enabled !== true) continue;
      const bit = permissionNameToBit(key);
      if (!bit) continue;
      bits |= bit;
      matched = true;
    }
    return matched ? bits : null;
  }

  return null;
}

function hasManageGuildFromBits(bits) {
  if (bits == null) return null;
  return Boolean((bits & ADMINISTRATOR_PERMISSION) !== 0n || (bits & MANAGE_GUILD_PERMISSION) !== 0n);
}

function getManageGuildFromMessagePayload(ctx) {
  const ownerId = ctx.message?.guild?.owner_id ?? ctx.message?.guild_owner_id ?? null;
  if (ownerId && ctx.authorId && String(ownerId) === String(ctx.authorId)) {
    return true;
  }

  const candidates = [
    ctx.message?.member?.permissions,
    ctx.message?.member?.permission,
    ctx.message?.member_permissions,
    ctx.message?.permissions,
    ctx.message?.member?.permission_names,
    ctx.message?.member?.permission_overwrites,
  ];

  for (const candidate of candidates) {
    const bits = extractPermissionBits(candidate);
    const verdict = hasManageGuildFromBits(bits);
    if (verdict != null) {
      return verdict;
    }
  }

  return null;
}

function permissionCacheKey(ctx) {
  return `${String(ctx.guildId ?? '')}:${String(ctx.authorId ?? '')}`;
}

function getCachedManageGuildPermission(ctx) {
  const key = permissionCacheKey(ctx);
  if (!key || key === ':') return null;

  const entry = manageGuildPermissionCache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    manageGuildPermissionCache.delete(key);
    return null;
  }

  return entry.value;
}

function setCachedManageGuildPermission(ctx, value) {
  const key = permissionCacheKey(ctx);
  if (!key || key === ':') return;

  manageGuildPermissionCache.set(key, {
    value,
    expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
  });
}

function extractRoleIdsFromMember(member) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles.map((id) => String(id));
  if (Array.isArray(member.role_ids)) return member.role_ids.map((id) => String(id));
  return [];
}

function computeMemberPermissionBitsFromRoles(member, roles) {
  const roleIds = extractRoleIdsFromMember(member);
  if (!roleIds.length || !Array.isArray(roles)) return null;

  const roleMap = new Map();
  for (const role of roles) {
    const id = String(role?.id ?? '');
    if (!id) continue;
    roleMap.set(id, role);
  }

  let bits = 0n;
  let matched = false;
  for (const roleId of roleIds) {
    const role = roleMap.get(String(roleId));
    if (!role) continue;
    const roleBits = extractPermissionBits(role.permissions ?? role.permission);
    if (roleBits == null) continue;
    bits |= roleBits;
    matched = true;
  }

  return matched ? bits : null;
}

async function getManageGuildFromRest(ctx) {
  if (!ctx.rest?.getGuildMember || !ctx.guildId || !ctx.authorId) {
    return null;
  }

  let member;
  try {
    member = await ctx.rest.getGuildMember(ctx.guildId, ctx.authorId);
  } catch {
    return null;
  }

  const directBits = extractPermissionBits(
    member?.permissions
    ?? member?.permission
    ?? member?.member?.permissions
  );
  const directVerdict = hasManageGuildFromBits(directBits);
  if (directVerdict != null) return directVerdict;

  let guild = null;
  if (ctx.rest?.getGuild) {
    try {
      guild = await ctx.rest.getGuild(ctx.guildId);
    } catch {
      guild = null;
    }
  }

  const guildOwnerId = guild?.owner_id ?? guild?.ownerId ?? null;
  if (guildOwnerId && String(guildOwnerId) === String(ctx.authorId)) return true;

  let roles = null;
  if (ctx.rest?.listGuildRoles) {
    try {
      const listed = await ctx.rest.listGuildRoles(ctx.guildId);
      if (Array.isArray(listed)) {
        roles = listed;
      }
    } catch {
      roles = null;
    }
  }
  if (!roles && Array.isArray(guild?.roles)) {
    roles = guild.roles;
  }

  const computedBits = computeMemberPermissionBitsFromRoles(member, roles);
  const computedVerdict = hasManageGuildFromBits(computedBits);
  if (computedVerdict != null) return computedVerdict;

  return null;
}

async function resolveManageGuildPermission(ctx) {
  const fromMessage = getManageGuildFromMessagePayload(ctx);
  if (fromMessage != null) {
    setCachedManageGuildPermission(ctx, fromMessage);
    return fromMessage;
  }

  const cached = getCachedManageGuildPermission(ctx);
  if (cached != null) {
    return cached;
  }

  const fromRest = await getManageGuildFromRest(ctx);
  if (fromRest != null) {
    setCachedManageGuildPermission(ctx, fromRest);
    return fromRest;
  }

  return null;
}

function userHasDjAccess(ctx, session) {
  const handoff = session?.tempDjHandoff ?? null;
  if (handoff && Number.isFinite(handoff.expiresAt) && handoff.expiresAt > Date.now()) {
    return String(handoff.userId) === String(ctx.authorId);
  }

  const djRoles = session.settings.djRoleIds;
  if (!djRoles || djRoles.size === 0) return true;

  const roles = getMemberRoleIds(ctx);
  return roles.some((roleId) => djRoles.has(roleId));
}

function userHasDjAccessByConfig(ctx, guildConfig) {
  const djRoles = getDjRoleSet(guildConfig);
  if (djRoles.size === 0) return true;

  const roles = getMemberRoleIds(ctx);
  return roles.some((roleId) => djRoles.has(roleId));
}

function ensureDjAccess(ctx, session, actionLabel) {
  if (userHasDjAccess(ctx, session)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

function ensureDjAccessByConfig(ctx, guildConfig, actionLabel) {
  if (userHasDjAccessByConfig(ctx, guildConfig)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

async function ensureManageGuildAccess(ctx, actionLabel) {
  const permission = await resolveManageGuildPermission(ctx);
  if (permission === true) return;

  if (permission === false) {
    throw new ValidationError(`You need the "Manage Server" permission to ${actionLabel}.`);
  }

  throw new ValidationError('Could not verify your server permissions right now. Try again in a few seconds.');
}

function ensureSessionTrack(ctx, session) {
  if (!session.player.currentTrack) {
    throw new ValidationError('Nothing is currently playing.');
  }
}

function computeVoteSkipRequirement(ctx, session) {
  const channelId = session.connection.channelId;
  if (!channelId) return 1;

  const listeners = ctx.voiceStateStore.countUsersInChannel(
    ctx.guildId,
    channelId,
    ctx.botUserId ? [ctx.botUserId] : []
  );

  if (listeners <= 1) return 1;
  const ratio = Number.isFinite(session.settings.voteSkipRatio)
    ? session.settings.voteSkipRatio
    : ctx.config.voteSkipRatio;
  const minVotes = Number.isFinite(session.settings.voteSkipMinVotes)
    ? session.settings.voteSkipMinVotes
    : ctx.config.voteSkipMinVotes;

  return Math.max(
    minVotes,
    Math.ceil(listeners * ratio)
  );
}

function isUserInPlaybackChannel(ctx, session) {
  const userChannelId = ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  return Boolean(userChannelId && session.connection.channelId && userChannelId === session.connection.channelId);
}

function createCommand(definition) {
  return Object.freeze(definition);
}

function buildHelpPages(ctx) {
  const commands = ctx.registry.list();
  const lines = commands.map((cmd) => {
    const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
    return `\`${ctx.prefix}${cmd.usage}\` - ${cmd.description}${aliases}`;
  });

  const pageSize = 12;
  const pages = [];
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));

  for (let i = 0; i < totalPages; i += 1) {
    const slice = lines.slice(i * pageSize, (i + 1) * pageSize);
    const payload = {
      embeds: [
        buildEmbed({
          title: `Help ${i + 1}/${totalPages}`,
          description: slice.join('\n').slice(0, 3900),
          footer: `Support: ${SUPPORT_SERVER_URL}`,
        }),
      ],
      allowed_mentions: {
        parse: [],
        users: [],
        roles: [],
        replied_user: false,
      },
    };
    pages.push(payload);
  }

  return pages;
}
export {
  HISTORY_PAGE_SIZE,
  PLAYLIST_PAGE_SIZE,
  FAVORITES_PAGE_SIZE,
  SEARCH_RESULT_DEFAULT_LIMIT,
  SUPPORT_SERVER_URL,
  parseVoiceChannelArgument,
  trackLabel,
  parseDurationToSeconds,
  formatSeconds,
  formatUptimeCompact,
  buildProgressBar,
  fetchGlobalGuildAndUserCounts,
  ensureGuild,
  getSessionOrThrow,
  getGuildConfigOrThrow,
  updateGuildConfig,
  ensureConnectedSession,
  applyVoiceProfileIfConfigured,
  resolveQueueGuard,
  formatQueuePage,
  formatHistoryPage,
  parseRequiredInteger,
  parseOnOff,
  enforcePlayCooldown,
  parseRoleId,
  parseTextChannelId,
  normalizeIndex,
  requireLibrary,
  saveSearchSelection,
  consumeSearchSelection,
  clearSearchSelection,
  ensureDjAccess,
  userHasDjAccess,
  ensureDjAccessByConfig,
  ensureManageGuildAccess,
  ensureSessionTrack,
  computeVoteSkipRequirement,
  isUserInPlaybackChannel,
  createCommand,
  buildHelpPages,
};
