import { ValidationError } from '../../../core/errors.js';
import {
  ADMINISTRATOR_PERMISSION,
  MANAGE_GUILD_PERMISSION,
  PERMISSION_CACHE_TTL_MS,
  ROLE_MENTION_PATTERN,
  VOICE_CHANNEL_PATTERN,
} from './constants.js';

const playCooldowns = new Map();
const manageGuildPermissionCache = new Map();

function getDjRoleSet(guildConfig) {
  const roleIds = guildConfig?.settings?.djRoleIds ?? [];
  return new Set(roleIds.map((roleId) => String(roleId)));
}

function getMemberRoleIds(ctx) {
  const roles = ctx.message?.member?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.map((roleId) => String(roleId));
}

export function parseRoleId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(ROLE_MENTION_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

export function parseTextChannelId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(VOICE_CHANNEL_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

export function enforcePlayCooldown(ctx) {
  const cooldownMs = Math.max(0, Number.parseInt(String(ctx.config.playCommandCooldownMs ?? 0), 10) || 0);
  if (cooldownMs <= 0) return;

  const userId = ctx.authorId ? String(ctx.authorId) : null;
  if (!userId) return;

  const key = `${ctx.guildId ? String(ctx.guildId) : 'dm'}:${userId}`;
  const now = Date.now();
  const last = playCooldowns.get(key) ?? 0;
  const remainingMs = cooldownMs - (now - last);
  if (remainingMs > 0) {
    throw new ValidationError(`You are using play too quickly. Please wait ${(remainingMs / 1000).toFixed(1)}s.`);
  }

  playCooldowns.set(key, now);
  if (playCooldowns.size > 10_000) {
    const staleBefore = now - Math.max(cooldownMs * 3, 60_000);
    for (const [entryKey, entryTs] of playCooldowns.entries()) {
      if (entryTs < staleBefore) playCooldowns.delete(entryKey);
    }
  }
}

function normalizePermissionName(name) {
  return String(name ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function permissionNameToBit(name) {
  const normalized = normalizePermissionName(name);
  if (!normalized) return null;
  if (normalized === 'ADMINISTRATOR' || normalized === 'ADMIN') return ADMINISTRATOR_PERMISSION;
  if (['MANAGE_GUILD', 'MANAGE_SERVER', 'SERVER_MANAGE', 'MANAGE_GUILD_SETTINGS'].includes(normalized)) {
    return MANAGE_GUILD_PERMISSION;
  }
  return null;
}

function extractPermissionBits(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);

    let bits = 0n;
    let matched = false;
    for (const part of trimmed.split(/[,\s|]+/).filter(Boolean)) {
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
  if (ownerId && ctx.authorId && String(ownerId) === String(ctx.authorId)) return true;

  for (const candidate of [
    ctx.message?.member?.permissions,
    ctx.message?.member?.permission,
    ctx.message?.member_permissions,
    ctx.message?.permissions,
    ctx.message?.member?.permission_names,
    ctx.message?.member?.permission_overwrites,
  ]) {
    const bits = extractPermissionBits(candidate);
    const verdict = hasManageGuildFromBits(bits);
    if (verdict != null) return verdict;
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
  manageGuildPermissionCache.set(key, { value, expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS });
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
    if (id) roleMap.set(id, role);
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
  if (!ctx.rest?.getGuildMember || !ctx.guildId || !ctx.authorId) return null;

  let member;
  try {
    member = await ctx.rest.getGuildMember(ctx.guildId, ctx.authorId);
  } catch {
    return null;
  }

  const directBits = extractPermissionBits(member?.permissions ?? member?.permission ?? member?.member?.permissions);
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
      if (Array.isArray(listed)) roles = listed;
    } catch {
      roles = null;
    }
  }
  if (!roles && Array.isArray(guild?.roles)) roles = guild.roles;

  const computedVerdict = hasManageGuildFromBits(computeMemberPermissionBitsFromRoles(member, roles));
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
  if (cached != null) return cached;

  const fromRest = await getManageGuildFromRest(ctx);
  if (fromRest != null) {
    setCachedManageGuildPermission(ctx, fromRest);
    return fromRest;
  }

  return null;
}

export function userHasDjAccess(ctx, session) {
  const handoff = session?.tempDjHandoff ?? null;
  if (handoff && Number.isFinite(handoff.expiresAt) && handoff.expiresAt > Date.now()) {
    return String(handoff.userId) === String(ctx.authorId);
  }

  const djRoles = session.settings.djRoleIds;
  if (!djRoles || djRoles.size === 0) return true;
  return getMemberRoleIds(ctx).some((roleId) => djRoles.has(roleId));
}

export function userHasDjAccessByConfig(ctx, guildConfig) {
  const djRoles = getDjRoleSet(guildConfig);
  if (djRoles.size === 0) return true;
  return getMemberRoleIds(ctx).some((roleId) => djRoles.has(roleId));
}

export function ensureDjAccess(ctx, session, actionLabel) {
  if (userHasDjAccess(ctx, session)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

export function ensureDjAccessByConfig(ctx, guildConfig, actionLabel) {
  if (userHasDjAccessByConfig(ctx, guildConfig)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

export async function ensureManageGuildAccess(ctx, actionLabel) {
  const permission = await resolveManageGuildPermission(ctx);
  if (permission === true) return;
  if (permission === false) {
    throw new ValidationError(`You need the "Manage Server" permission to ${actionLabel}.`);
  }
  throw new ValidationError('Could not verify your server permissions right now. Try again in a few seconds.');
}
