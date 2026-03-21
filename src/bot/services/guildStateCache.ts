import {
  ADMINISTRATOR_PERMISSION,
  MANAGE_GUILD_PERMISSION,
} from '../commands/helpers/constants.ts';

function toRoleArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type LooseGuildPayload = Record<string, unknown>;
type RoleMapEntry = [string, bigint];

function isRoleMapEntry(value: unknown): value is RoleMapEntry {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'bigint';
}

function normalizeGuildPayload(raw: unknown): LooseGuildPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const typed = raw as LooseGuildPayload;

  if (typed.properties && typeof typed.properties === 'object') {
    return {
      ...(typed.properties as LooseGuildPayload),
      roles: toRoleArray(typed.roles),
    };
  }

  return typed;
}

function toPermissionBits(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }
  return null;
}

import type { LoggerLike } from '../../types/core.ts';

type GuildRoleState = {
  ownerId: string | null;
  roles: Map<string, bigint>;
};

export class GuildStateCache {
  logger?: LoggerLike | null;
  guilds: Map<string, GuildRoleState>;

  constructor(logger: LoggerLike | null = null) {
    this.logger = logger;
    this.guilds = new Map();
  }

  register(gateway: { on: (event: string, handler: (payload: unknown) => void) => void }) {
    gateway.on('READY', (payload: unknown) => {
      const typed = (payload ?? {}) as { guilds?: unknown[] | null };
      for (const rawGuild of typed.guilds ?? []) {
        this._upsertGuild(rawGuild);
      }
    });

    gateway.on('GUILD_CREATE', (payload: unknown) => {
      this._upsertGuild(payload);
    });

    gateway.on('GUILD_UPDATE', (payload: unknown) => {
      this._upsertGuild(payload);
    });

    gateway.on('GUILD_DELETE', (payload: unknown) => {
      const typed = (payload ?? {}) as { id?: string; guild_id?: string };
      const guildId = String(typed.id ?? typed.guild_id ?? '').trim();
      if (!guildId) return;
      this.guilds.delete(guildId);
    });

    gateway.on('GUILD_ROLE_CREATE', (payload: unknown) => {
      const typed = (payload ?? {}) as { guild_id?: string; role?: unknown };
      this._upsertRole(typed.guild_id, typed.role);
    });

    gateway.on('GUILD_ROLE_UPDATE', (payload: unknown) => {
      const typed = (payload ?? {}) as { guild_id?: string; role?: unknown };
      this._upsertRole(typed.guild_id, typed.role);
    });

    gateway.on('GUILD_ROLE_DELETE', (payload: unknown) => {
      const typed = (payload ?? {}) as { guild_id?: string; role_id?: string };
      const guildId = String(typed.guild_id ?? '').trim();
      const roleId = String(typed.role_id ?? '').trim();
      if (!guildId || !roleId) return;
      this.guilds.get(guildId)?.roles.delete(roleId);
    });
  }

  resolveOwnerId(guildId: unknown): string | null {
    const guild = this.guilds.get(String(guildId ?? '').trim());
    return guild?.ownerId ?? null;
  }

  computeManageGuildPermission(guildId: unknown, roleIds: unknown[] = [], userId: unknown = null): boolean | null {
    const guild = this.guilds.get(String(guildId ?? '').trim());
    if (!guild) return null;

    const safeUserId = String(userId ?? '').trim();
    if (safeUserId && guild.ownerId && guild.ownerId === safeUserId) {
      return true;
    }

    const uniqueRoleIds = [...new Set((roleIds ?? []).map((roleId) => String(roleId ?? '').trim()).filter(Boolean))];
    if (!uniqueRoleIds.length) return null;

    let bits = 0n;
    let matched = false;
    for (const roleId of uniqueRoleIds) {
      const roleBits = guild.roles.get(roleId);
      if (roleBits == null) continue;
      bits |= roleBits;
      matched = true;
    }

    if (!matched) return null;
    return Boolean((bits & ADMINISTRATOR_PERMISSION) !== 0n || (bits & MANAGE_GUILD_PERMISSION) !== 0n);
  }

  _upsertGuild(rawGuild: unknown): void {
    const guild = normalizeGuildPayload(rawGuild);
    const guildId = String(guild?.id ?? '').trim();
    if (!guildId) return;

    const existing = this.guilds.get(guildId) ?? {
      ownerId: null,
      roles: new Map(),
    };

    const ownerId = String(guild?.owner_id ?? guild?.ownerId ?? existing.ownerId ?? '').trim() || null;
    const roles = Array.isArray(guild?.roles) ? guild.roles : null;
    const nextRoles = roles
      ? new Map(
        roles
          .map((role): RoleMapEntry | null => {
            const typedRole = (role ?? {}) as { id?: string; permissions?: unknown; permission?: unknown };
            const roleId = String(typedRole.id ?? '').trim();
            const bits = toPermissionBits(typedRole.permissions ?? typedRole.permission);
            return roleId && bits != null ? [roleId, bits] : null;
          })
          .filter(isRoleMapEntry)
      )
      : existing.roles;

    this.guilds.set(guildId, {
      ownerId,
      roles: nextRoles,
    });
  }

  _upsertRole(guildId: unknown, role: unknown): void {
    const typedRole = (role ?? {}) as { id?: string; permissions?: unknown; permission?: unknown };
    const safeGuildId = String(guildId ?? '').trim();
    const roleId = String(typedRole.id ?? '').trim();
    const bits = toPermissionBits(typedRole.permissions ?? typedRole.permission);
    if (!safeGuildId || !roleId || bits == null) return;

    let guild = this.guilds.get(safeGuildId);
    if (!guild) {
      guild = {
        ownerId: null,
        roles: new Map(),
      };
      this.guilds.set(safeGuildId, guild);
    }

    guild.roles.set(roleId, bits);
  }
}


