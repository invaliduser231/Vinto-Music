import { ValidationError } from '../../../core/errors.ts';
import {
  ADMINISTRATOR_PERMISSION,
  MANAGE_GUILD_PERMISSION,
  PERMISSION_CACHE_TTL_MS,
  ROLE_MENTION_PATTERN,
  VOICE_CHANNEL_PATTERN,
} from './constants.ts';
import type { CommandContextLike, GuildConfigLike, SessionLike } from './types.ts';

const playCooldowns = new Map<string, number>();
const manageGuildPermissionCache = new Map<string, { expiresAt: number; value: boolean }>();

type PermissionCarrier = Record<string, unknown> & {
  permissions?: unknown;
  permission?: unknown;
  bitfield?: unknown;
};

function getDjRoleSet(guildConfig: GuildConfigLike) {
  const roleIds = guildConfig?.settings?.djRoleIds ?? [];
  return new Set(roleIds.map((roleId: unknown) => String(roleId)));
}

function getMemberRoleIds(ctx: CommandContextLike) {
  const roles = (ctx.message as { member?: { roles?: unknown[] } })?.member?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.map((roleId) => String(roleId));
}

export function parseRoleId(value: unknown) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(ROLE_MENTION_PATTERN);
  if (mention) return mention[1] ?? null;
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

export function parseTextChannelId(value: unknown) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(VOICE_CHANNEL_PATTERN);
  if (mention) return mention[1] ?? null;
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

export function enforcePlayCooldown(ctx: CommandContextLike) {
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

function normalizePermissionName(name: unknown) {
  return String(name ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function permissionNameToBit(name: unknown) {
  const normalized = normalizePermissionName(name);
  if (!normalized) return null;
  if (normalized === 'ADMINISTRATOR' || normalized === 'ADMIN') return ADMINISTRATOR_PERMISSION;
  if (['MANAGE_GUILD', 'MANAGE_SERVER', 'SERVER_MANAGE', 'MANAGE_GUILD_SETTINGS'].includes(normalized)) {
    return MANAGE_GUILD_PERMISSION;
  }
  return null;
}

function extractPermissionBits(value: unknown, depth: number = 0): bigint | null {
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
    const carrier = value as PermissionCarrier;
    if (carrier.permissions !== undefined && carrier.permissions !== value) {
      const nested = extractPermissionBits(carrier.permissions, depth + 1);
      if (nested != null) return nested;
    }
    if (carrier.bitfield !== undefined && carrier.bitfield !== value) {
      const nested = extractPermissionBits(carrier.bitfield, depth + 1);
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

function hasManageGuildFromBits(bits: bigint | null) {
  if (bits == null) return null;
  return Boolean((bits & ADMINISTRATOR_PERMISSION) !== 0n || (bits & MANAGE_GUILD_PERMISSION) !== 0n);
}

function hasDirectPermissionPayload(ctx: CommandContextLike) {
  const message = ctx.message as {
    member?: {
      permissions?: unknown;
      permission?: unknown;
      permission_names?: unknown;
      permission_overwrites?: unknown;
    };
    member_permissions?: unknown;
    permissions?: unknown;
  };
  return [
    message.member?.permissions,
    message.member?.permission,
    message.member_permissions,
    message.permissions,
    message.member?.permission_names,
    message.member?.permission_overwrites,
  ].some((candidate) => candidate != null);
}

function getManageGuildFromMessagePayload(ctx: CommandContextLike) {
  const message = ctx.message as {
    guild?: { owner_id?: string };
    guild_owner_id?: string;
    member?: {
      permissions?: unknown;
      permission?: unknown;
      permission_names?: unknown;
      permission_overwrites?: unknown;
    };
    member_permissions?: unknown;
    permissions?: unknown;
  };
  const member = message.member ?? null;
  const ownerId = message.guild?.owner_id
    ?? message.guild_owner_id
    ?? ctx.guildStateCache?.resolveOwnerId?.(ctx.guildId)
    ?? null;
  if (ownerId && ctx.authorId && String(ownerId) === String(ctx.authorId)) return true;

  for (const candidate of [
    member?.permissions,
    member?.permission,
    message.member_permissions,
    message.permissions,
    member?.permission_names,
    member?.permission_overwrites,
  ]) {
    const bits = extractPermissionBits(candidate);
    const verdict = hasManageGuildFromBits(bits);
    if (verdict != null) return verdict;
  }

  return null;
}

function getManageGuildFromGatewayCache(ctx: CommandContextLike, roleIds: string[] | null = null) {
  if (!ctx.guildStateCache?.computeManageGuildPermission || !ctx.guildId || !ctx.authorId) {
    return null;
  }

  const resolvedRoleIds = Array.isArray(roleIds) ? roleIds : getMemberRoleIds(ctx);
  if (!resolvedRoleIds.length) return null;

  return ctx.guildStateCache.computeManageGuildPermission(ctx.guildId, resolvedRoleIds, ctx.authorId);
}

function permissionCacheKey(ctx: CommandContextLike) {
  return `${String(ctx.guildId ?? '')}:${String(ctx.authorId ?? '')}`;
}

function getCachedManageGuildPermission(ctx: CommandContextLike) {
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

function setCachedManageGuildPermission(ctx: CommandContextLike, value: boolean) {
  const key = permissionCacheKey(ctx);
  if (!key || key === ':') return;
  manageGuildPermissionCache.set(key, { value, expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS });
}

function extractRoleIdsFromMember(member: { roles?: unknown[]; role_ids?: unknown[] } | null | undefined) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles.map((id: unknown) => String(id));
  if (Array.isArray(member.role_ids)) return member.role_ids.map((id: unknown) => String(id));
  return [];
}

function computePermissionBitsFromRoleIds(roleIds: string[], roles: Array<Record<string, unknown>> | null) {
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

async function getManageGuildFromRest(ctx: CommandContextLike) {
  const diagnostics: {
    memberStatus: number | null;
    guildStatus: number | null;
    rolesStatus: number | null;
  } = {
    memberStatus: null,
    guildStatus: null,
    rolesStatus: null,
  };
  if (!ctx.guildId || !ctx.authorId) return null;

  let member: Record<string, unknown> | null = null;
  if (ctx.rest?.getGuildMember) {
    try {
      member = await ctx.rest.getGuildMember(ctx.guildId, ctx.authorId) as Record<string, unknown>;
    } catch (err: unknown) {
      diagnostics.memberStatus = (err as { status?: number })?.status ?? null;
      member = null;
    }
  }

  const memberRecord = member as {
    permissions?: unknown;
    permission?: unknown;
    member?: { permissions?: unknown };
  } | null;
  const directBits = extractPermissionBits(memberRecord?.permissions ?? memberRecord?.permission ?? memberRecord?.member?.permissions);
  const directVerdict = hasManageGuildFromBits(directBits);
  if (directVerdict != null) return directVerdict;

  let guild: Record<string, unknown> | null = null;
  if (ctx.rest?.getGuild) {
    try {
      guild = await ctx.rest.getGuild(ctx.guildId) as Record<string, unknown>;
    } catch (err: unknown) {
      diagnostics.guildStatus = (err as { status?: number })?.status ?? null;
      guild = null;
    }
  }

  const guildRecord = guild as { owner_id?: string; ownerId?: string; roles?: Array<Record<string, unknown>> } | null;
  const guildOwnerId = guildRecord?.owner_id ?? guildRecord?.ownerId ?? null;
  if (guildOwnerId && String(guildOwnerId) === String(ctx.authorId)) return true;

  let roles = null;
  if (ctx.rest?.listGuildRoles) {
    try {
      const listed = await ctx.rest.listGuildRoles(ctx.guildId);
      if (Array.isArray(listed)) roles = listed;
    } catch (err: unknown) {
      diagnostics.rolesStatus = (err as { status?: number })?.status ?? null;
      roles = null;
    }
  }
  if (!roles && Array.isArray(guildRecord?.roles)) roles = guildRecord.roles;

  const messageRoleIds = extractRoleIdsFromMember((ctx.message as { member?: { roles?: unknown[]; role_ids?: unknown[] } }).member);
  const memberRoleIds = extractRoleIdsFromMember(member);

  for (const roleIds of [memberRoleIds, messageRoleIds]) {
    const cachedVerdict = getManageGuildFromGatewayCache(ctx, roleIds);
    if (cachedVerdict != null) return cachedVerdict;

    const computedVerdict = hasManageGuildFromBits(computePermissionBitsFromRoleIds(roleIds, roles));
    if (computedVerdict != null) return computedVerdict;
  }

  return diagnostics;
}

function buildManageGuildVerificationMessage(ctx: CommandContextLike, diagnostics: { rolesStatus: number | null; guildStatus: number | null } | null) {
  const roleIds = getMemberRoleIds(ctx);
  const hasDirectPermissions = hasDirectPermissionPayload(ctx);

  if (diagnostics?.rolesStatus === 403) {
    return 'Could not verify your server permissions because Fluxer denied the bot access to this server\'s role list.';
  }

  if ((diagnostics?.guildStatus ?? 0) >= 500) {
    return 'Could not verify your server permissions because Fluxer returned a server error for this guild\'s metadata.';
  }

  if (!hasDirectPermissions && roleIds.length > 0 && !ctx.guildStateCache) {
    return 'Could not verify your server permissions because this message only included role IDs and no cached guild role data was available.';
  }

  if (!hasDirectPermissions && roleIds.length > 0) {
    return 'Could not verify your server permissions because Fluxer did not include direct permission bits in the message, and the bot could not resolve your role permissions for this server.';
  }

  if (!hasDirectPermissions && roleIds.length === 0) {
    return 'Could not verify your server permissions because Fluxer did not include your permissions or roles in this message.';
  }

  return 'Could not verify your server permissions right now because Fluxer did not return enough permission data for this server.';
}

async function resolveManageGuildPermission(ctx: CommandContextLike) {
  const fromMessage = getManageGuildFromMessagePayload(ctx);
  if (fromMessage != null) {
    setCachedManageGuildPermission(ctx, fromMessage);
    return { value: fromMessage, diagnostics: null };
  }

  const fromGatewayCache = getManageGuildFromGatewayCache(ctx);
  if (fromGatewayCache != null) {
    setCachedManageGuildPermission(ctx, fromGatewayCache);
    return { value: fromGatewayCache, diagnostics: null };
  }

  const cached = getCachedManageGuildPermission(ctx);
  if (cached != null) return { value: cached, diagnostics: null };

  const fromRest = await getManageGuildFromRest(ctx);
  if (typeof fromRest === 'boolean') {
    setCachedManageGuildPermission(ctx, fromRest);
    return { value: fromRest, diagnostics: null };
  }

  return { value: null, diagnostics: fromRest };
}

export function userHasDjAccess(ctx: CommandContextLike, session: SessionLike) {
  const handoff = session?.tempDjHandoff ?? null;
  if (handoff && Number.isFinite(handoff.expiresAt) && handoff.expiresAt > Date.now()) {
    return String(handoff.userId) === String(ctx.authorId);
  }

  const djRoles = session.settings.djRoleIds;
  if (!djRoles || djRoles.size === 0) return true;
  return getMemberRoleIds(ctx).some((roleId) => djRoles.has(roleId));
}

export function userHasDjAccessByConfig(ctx: CommandContextLike, guildConfig: GuildConfigLike) {
  const djRoles = getDjRoleSet(guildConfig);
  if (djRoles.size === 0) return true;
  return getMemberRoleIds(ctx).some((roleId) => djRoles.has(roleId));
}

export function ensureDjAccess(ctx: CommandContextLike, session: SessionLike, actionLabel: string) {
  if (userHasDjAccess(ctx, session)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

export function ensureDjAccessByConfig(ctx: CommandContextLike, guildConfig: GuildConfigLike, actionLabel: string) {
  if (userHasDjAccessByConfig(ctx, guildConfig)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

export async function ensureManageGuildAccess(ctx: CommandContextLike, actionLabel: string) {
  const { value: permission, diagnostics } = await resolveManageGuildPermission(ctx);
  if (permission === true) return;
  if (permission === false) {
    throw new ValidationError(`You need the "Manage Server" permission to ${actionLabel}.`);
  }
  throw new ValidationError(buildManageGuildVerificationMessage(ctx, diagnostics));
}


