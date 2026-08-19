import {
  ALL_PERMISSIONS,
  OVERWRITE_TYPE_MEMBER,
  OVERWRITE_TYPE_ROLE,
  PERMISSION_FLAGS,
  isAdministrator,
  missingPermissions,
  toPermissionBits,
  type PermissionFlag,
} from './flags.ts';

export type PermissionUnknownReason =
  | 'no_rest'
  | 'no_user'
  | 'missing_ids'
  | 'member_unavailable'
  | 'guild_unavailable'
  | 'roles_unavailable'
  | 'channel_unavailable'
  | 'lookup_failed';

export type PermissionSource = 'owner' | 'administrator' | 'computed';

export interface PermissionResolution {
  known: boolean;
  bits: bigint | null;
  reason: PermissionUnknownReason | null;
  source: PermissionSource | null;
  isOwner: boolean;
  isAdministrator: boolean;
}

export interface PermissionCheck extends PermissionResolution {
  ok: boolean;
  missing: PermissionFlag[];
  required: PermissionFlag[];
}

export type MemberPayload = {
  roles?: unknown[];
  role_ids?: unknown[];
};

export type RolePayload = {
  id?: unknown;
  permissions?: unknown;
  permission?: unknown;
};

export type GuildPayload = {
  id?: unknown;
  guild_id?: unknown;
  owner_id?: unknown;
  ownerId?: unknown;
  roles?: RolePayload[];
};

export type OverwritePayload = {
  id?: unknown;
  type?: unknown;
  allow?: unknown;
  deny?: unknown;
};

export type ChannelPayload = {
  permission_overwrites?: OverwritePayload[];
  permissionOverwrites?: OverwritePayload[];
};

export function memberRoleIds(member: MemberPayload | null | undefined): string[] {
  if (Array.isArray(member?.roles)) return member.roles.map((id) => String(id));
  if (Array.isArray(member?.role_ids)) return member.role_ids.map((id) => String(id));
  return [];
}

export function channelOverwrites(channel: ChannelPayload | null | undefined): OverwritePayload[] {
  if (Array.isArray(channel?.permission_overwrites)) return channel.permission_overwrites;
  if (Array.isArray(channel?.permissionOverwrites)) return channel.permissionOverwrites;
  return [];
}

function overwriteType(entry: OverwritePayload): number | null {
  const raw = entry?.type;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return null;
}

function matchingOverwrites(overwrites: OverwritePayload[], id: unknown, type: number): OverwritePayload[] {
  const key = String(id ?? '').trim();
  if (!key) return [];
  return overwrites.filter((entry) => {
    if (String(entry?.id ?? '') !== key) return false;
    const entryType = overwriteType(entry);
    return entryType == null || entryType === type;
  });
}

function applyOverwrite(bits: bigint, overwrite: OverwritePayload): bigint {
  const deny = toPermissionBits(overwrite?.deny) ?? 0n;
  const allow = toPermissionBits(overwrite?.allow) ?? 0n;
  return (bits & ~deny) | allow;
}

export function computeBasePermissions(
  member: MemberPayload | null | undefined,
  guild: GuildPayload | null | undefined
): bigint | null {
  const roles = Array.isArray(guild?.roles) ? guild.roles : [];
  if (!roles.length) return null;

  const byId = new Map<string, RolePayload>();
  for (const role of roles) {
    const id = String(role?.id ?? '');
    if (id) byId.set(id, role);
  }

  const everyoneId = String(guild?.id ?? guild?.guild_id ?? '');
  let bits = 0n;
  let matched = false;

  const everyoneRole = everyoneId ? byId.get(everyoneId) : null;
  if (everyoneRole) {
    const roleBits = toPermissionBits(everyoneRole.permissions ?? everyoneRole.permission);
    if (roleBits != null) {
      bits |= roleBits;
      matched = true;
    }
  }

  for (const roleId of memberRoleIds(member)) {
    if (roleId === everyoneId) continue;
    const role = byId.get(roleId);
    if (!role) continue;
    const roleBits = toPermissionBits(role.permissions ?? role.permission);
    if (roleBits == null) continue;
    bits |= roleBits;
    matched = true;
  }

  return matched ? bits : null;
}

export function applyChannelOverwrites(
  basePermissions: bigint,
  member: MemberPayload | null | undefined,
  guild: GuildPayload | null | undefined,
  channel: ChannelPayload | null | undefined,
  userId: string
): bigint {
  if (isAdministrator(basePermissions)) return ALL_PERMISSIONS;

  let bits = basePermissions;
  const overwrites = channelOverwrites(channel);
  const everyoneId = String(guild?.id ?? guild?.guild_id ?? '').trim();

  for (const everyone of matchingOverwrites(overwrites, everyoneId, OVERWRITE_TYPE_ROLE)) {
    bits = applyOverwrite(bits, everyone);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const roleId of memberRoleIds(member)) {
    if (roleId === everyoneId) continue;
    for (const entry of matchingOverwrites(overwrites, roleId, OVERWRITE_TYPE_ROLE)) {
      roleAllow |= toPermissionBits(entry.allow) ?? 0n;
      roleDeny |= toPermissionBits(entry.deny) ?? 0n;
    }
  }
  bits = (bits & ~roleDeny) | roleAllow;

  for (const memberOverwrite of matchingOverwrites(overwrites, userId, OVERWRITE_TYPE_MEMBER)) {
    bits = applyOverwrite(bits, memberOverwrite);
  }

  return bits;
}

export function resolveMemberPermissions(options: {
  member: MemberPayload | null | undefined;
  guild: GuildPayload | null | undefined;
  channel: ChannelPayload | null | undefined;
  userId: string;
}): PermissionResolution {
  const { member, guild, channel, userId } = options;

  if (!guild) {
    return unknownResolution('guild_unavailable');
  }

  const ownerId = String(guild.owner_id ?? guild.ownerId ?? '').trim();
  if (ownerId && ownerId === userId) {
    return {
      known: true,
      bits: ALL_PERMISSIONS,
      reason: null,
      source: 'owner',
      isOwner: true,
      isAdministrator: true,
    };
  }

  if (!member) {
    return unknownResolution('member_unavailable');
  }

  const base = computeBasePermissions(member, guild);
  if (base == null) {
    return unknownResolution('roles_unavailable');
  }

  if (isAdministrator(base)) {
    return {
      known: true,
      bits: ALL_PERMISSIONS,
      reason: null,
      source: 'administrator',
      isOwner: false,
      isAdministrator: true,
    };
  }

  if (!channel) {
    return unknownResolution('channel_unavailable');
  }

  const bits = applyChannelOverwrites(base, member, guild, channel, userId);
  return {
    known: true,
    bits,
    reason: null,
    source: 'computed',
    isOwner: false,
    isAdministrator: isAdministrator(bits),
  };
}

export function unknownResolution(reason: PermissionUnknownReason): PermissionResolution {
  return {
    known: false,
    bits: null,
    reason,
    source: null,
    isOwner: false,
    isAdministrator: false,
  };
}

export function checkResolution(
  resolution: PermissionResolution,
  required: readonly PermissionFlag[]
): PermissionCheck {
  const requiredList = [...required];

  if (!resolution.known || resolution.bits == null) {
    return { ...resolution, ok: false, missing: [], required: requiredList };
  }

  const missing = orderMissing(missingPermissions(resolution.bits, requiredList));
  return { ...resolution, ok: missing.length === 0, missing, required: requiredList };
}

function orderMissing(missing: PermissionFlag[]): PermissionFlag[] {
  if (missing.length < 2) return missing;
  const viewIndex = missing.indexOf('VIEW_CHANNEL');
  if (viewIndex <= 0) return missing;
  const reordered = [...missing];
  reordered.splice(viewIndex, 1);
  reordered.unshift('VIEW_CHANNEL');
  return reordered;
}

export { PERMISSION_FLAGS, type PermissionFlag };
