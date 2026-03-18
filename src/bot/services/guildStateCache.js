import {
  ADMINISTRATOR_PERMISSION,
  MANAGE_GUILD_PERMISSION,
} from '../commands/helpers/constants.js';

function toRoleArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeGuildPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.properties && typeof raw.properties === 'object') {
    return {
      ...raw.properties,
      roles: toRoleArray(raw.roles),
    };
  }

  return raw;
}

function toPermissionBits(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }
  return null;
}

export class GuildStateCache {
  constructor(logger = null) {
    this.logger = logger;
    this.guilds = new Map();
  }

  register(gateway) {
    gateway.on('READY', (payload) => {
      for (const rawGuild of payload?.guilds ?? []) {
        this._upsertGuild(rawGuild);
      }
    });

    gateway.on('GUILD_CREATE', (payload) => {
      this._upsertGuild(payload);
    });

    gateway.on('GUILD_UPDATE', (payload) => {
      this._upsertGuild(payload);
    });

    gateway.on('GUILD_DELETE', (payload) => {
      const guildId = String(payload?.id ?? payload?.guild_id ?? '').trim();
      if (!guildId) return;
      this.guilds.delete(guildId);
    });

    gateway.on('GUILD_ROLE_CREATE', (payload) => {
      this._upsertRole(payload?.guild_id, payload?.role);
    });

    gateway.on('GUILD_ROLE_UPDATE', (payload) => {
      this._upsertRole(payload?.guild_id, payload?.role);
    });

    gateway.on('GUILD_ROLE_DELETE', (payload) => {
      const guildId = String(payload?.guild_id ?? '').trim();
      const roleId = String(payload?.role_id ?? '').trim();
      if (!guildId || !roleId) return;
      this.guilds.get(guildId)?.roles.delete(roleId);
    });
  }

  resolveOwnerId(guildId) {
    const guild = this.guilds.get(String(guildId ?? '').trim());
    return guild?.ownerId ?? null;
  }

  computeManageGuildPermission(guildId, roleIds = [], userId = null) {
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

  _upsertGuild(rawGuild) {
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
          .map((role) => {
            const roleId = String(role?.id ?? '').trim();
            const bits = toPermissionBits(role?.permissions ?? role?.permission);
            return roleId && bits != null ? [roleId, bits] : null;
          })
          .filter(Boolean)
      )
      : existing.roles;

    this.guilds.set(guildId, {
      ownerId,
      roles: nextRoles,
    });
  }

  _upsertRole(guildId, role) {
    const safeGuildId = String(guildId ?? '').trim();
    const roleId = String(role?.id ?? '').trim();
    const bits = toPermissionBits(role?.permissions ?? role?.permission);
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
