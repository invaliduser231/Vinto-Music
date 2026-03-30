const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

function toBigInt(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }

  return null;
}

function roleIdsFromMember(member: GuildMemberPayload): string[] {
  if (Array.isArray(member?.roles)) return member.roles.map((id: unknown) => String(id));
  if (Array.isArray(member?.role_ids)) return member.role_ids.map((id: unknown) => String(id));
  return [];
}

function getOverwrites(channel: ChannelPayload): ChannelOverwrite[] {
  if (Array.isArray(channel?.permission_overwrites)) return channel.permission_overwrites;
  if (Array.isArray(channel?.permissionOverwrites)) return channel.permissionOverwrites;
  return [];
}

function findOverwrite(overwrites: ChannelOverwrite[], id: unknown): ChannelOverwrite | null {
  const key = String(id);
  return overwrites.find((entry: ChannelOverwrite) => String(entry?.id ?? '') === key) ?? null;
}

type CachedEntry<T> = {
  value: T;
  expiresAt: number;
};

type PermissionBitsCarrier = {
  permissions?: unknown;
  permission?: unknown;
};

type GuildRole = PermissionBitsCarrier & {
  id?: unknown;
};

type GuildPayload = {
  id?: unknown;
  guild_id?: unknown;
  roles?: GuildRole[];
};

type GuildMemberPayload = {
  roles?: unknown[];
  role_ids?: unknown[];
};

type ChannelOverwrite = {
  id?: unknown;
  deny?: unknown;
  allow?: unknown;
};

type ChannelPayload = {
  permission_overwrites?: ChannelOverwrite[];
  permissionOverwrites?: ChannelOverwrite[];
};

type PermissionResolution = {
  known: boolean;
  bits: bigint | null;
  canViewChannel: boolean;
  canSendMessages: boolean;
  canEmbedLinks: boolean;
  canConnect: boolean;
  canSpeak: boolean;
};

type PermissionServiceOptions = {
  rest?: {
    getChannel: (channelId: string) => Promise<unknown>;
    getGuildMember: (guildId: string, userId: string) => Promise<unknown>;
    getGuild: (guildId: string) => Promise<unknown>;
  };
  botUserId?: string | null;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  } | null;
  cacheTtlMs?: number;
  maxGuildMemberCacheSize?: number;
  maxGuildCacheSize?: number;
  maxChannelPermCacheSize?: number;
};

export class PermissionService {
  rest: PermissionServiceOptions['rest'] | undefined;
  botUserId: string | null;
  logger: PermissionServiceOptions['logger'];
  cacheTtlMs: number;
  maxGuildMemberCacheSize: number;
  maxGuildCacheSize: number;
  maxChannelPermCacheSize: number;
  guildMemberCache: Map<string, CachedEntry<unknown>>;
  guildCache: Map<string, CachedEntry<unknown>>;
  channelPermCache: Map<string, CachedEntry<PermissionResolution>>;
  cacheSweepHandle: NodeJS.Timeout | null;

  constructor(options: PermissionServiceOptions = {}) {
    this.rest = options.rest;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;
    this.logger = options.logger;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.maxGuildMemberCacheSize = options.maxGuildMemberCacheSize ?? 2_000;
    this.maxGuildCacheSize = options.maxGuildCacheSize ?? 500;
    this.maxChannelPermCacheSize = options.maxChannelPermCacheSize ?? 5_000;

    this.guildMemberCache = new Map();
    this.guildCache = new Map();
    this.channelPermCache = new Map();
    this.cacheSweepHandle = setInterval(() => {
      this._pruneExpiredEntries(this.guildMemberCache);
      this._pruneExpiredEntries(this.guildCache);
      this._pruneExpiredEntries(this.channelPermCache);
    }, Math.max(5_000, this.cacheTtlMs));
    this.cacheSweepHandle.unref?.();
  }

  setBotUserId(botUserId: unknown): void {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  async canBotSendMessages(guildId: unknown, channelId: unknown): Promise<boolean | null> {
    const perms = await this.getBotChannelPermissions(guildId, channelId);
    if (!perms.known) return null;
    return perms.canViewChannel && perms.canSendMessages;
  }

  async canBotJoinAndSpeak(guildId: unknown, channelId: unknown): Promise<boolean | null> {
    const perms = await this.getBotChannelPermissions(guildId, channelId);
    if (!perms.known) return null;
    return perms.canViewChannel && perms.canConnect && perms.canSpeak;
  }

  async getBotChannelPermissions(guildId: unknown, channelId: unknown): Promise<PermissionResolution> {
    const safeGuildId = String(guildId ?? '').trim();
    const safeChannelId = String(channelId ?? '').trim();
    if (!safeGuildId || !safeChannelId || !this.botUserId) {
      return this._unknown();
    }

    const cacheKey = `${safeGuildId}:${safeChannelId}`;
    const cached = this._getCached(this.channelPermCache, cacheKey);
    if (cached) return cached;

    try {
      if (!this.rest) return this._unknown();
      const [member, guild, channel] = await Promise.all([
        this._getGuildMember(safeGuildId, this.botUserId),
        this._getGuild(safeGuildId),
        this.rest.getChannel(safeChannelId),
      ]);

      const basePerms = this._computeBaseRolePerms(member as GuildMemberPayload, guild as GuildPayload);
      if (basePerms == null) {
        return this._cacheAndReturnUnknown(cacheKey);
      }

      const effectivePerms = this._applyChannelOverwrites(
        basePerms,
        member as GuildMemberPayload,
        guild as GuildPayload,
        channel as ChannelPayload
      );
      const result = this._fromBits(effectivePerms);
      this._setCached(this.channelPermCache, cacheKey, result, this.maxChannelPermCacheSize);
      return result;
    } catch (err) {
      this.logger?.debug?.('Permission resolution failed', {
        guildId: safeGuildId,
        channelId: safeChannelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._cacheAndReturnUnknown(cacheKey);
    }
  }

  _computeBaseRolePerms(member: GuildMemberPayload, guild: GuildPayload): bigint | null {
    const roles = Array.isArray(guild?.roles) ? guild.roles : [];
    if (!roles.length) return null;

    const map = new Map<string, GuildRole>();
    for (const role of roles) {
      const id = String(role?.id ?? '');
      if (!id) continue;
      map.set(id, role);
    }

    const roleIds = roleIdsFromMember(member);
    if (!roleIds.length) return null;

    let perms = 0n;
    let matched = false;
    for (const roleId of roleIds) {
      const role = map.get(String(roleId));
      if (!role) continue;
      const bits = toBigInt(role.permissions ?? role.permission);
      if (bits == null) continue;
      perms |= bits;
      matched = true;
    }

    return matched ? perms : null;
  }

  _applyChannelOverwrites(
    basePerms: bigint,
    member: GuildMemberPayload,
    guild: GuildPayload,
    channel: ChannelPayload
  ): bigint {
    if ((basePerms & ADMINISTRATOR) !== 0n) {
      return basePerms;
    }

    let perms = basePerms;
    const overwrites = getOverwrites(channel);

    const everyone = findOverwrite(overwrites, guild?.id ?? guild?.guild_id);
    if (everyone) {
      perms = this._applyOverwrite(perms, everyone);
    }

    const roleIds = roleIdsFromMember(member);
    let roleDeny = 0n;
    let roleAllow = 0n;
    for (const roleId of roleIds) {
      const ow = findOverwrite(overwrites, roleId);
      if (!ow) continue;
      roleDeny |= toBigInt(ow.deny) ?? 0n;
      roleAllow |= toBigInt(ow.allow) ?? 0n;
    }
    perms &= ~roleDeny;
    perms |= roleAllow;

    const memberOw = findOverwrite(overwrites, this.botUserId);
    if (memberOw) {
      perms = this._applyOverwrite(perms, memberOw);
    }

    return perms;
  }

  _applyOverwrite(perms: bigint, overwrite: ChannelOverwrite) {
    const deny = toBigInt(overwrite?.deny) ?? 0n;
    const allow = toBigInt(overwrite?.allow) ?? 0n;
    let next = perms;
    next &= ~deny;
    next |= allow;
    return next;
  }

  _fromBits(bits: bigint): PermissionResolution {
    const canViewChannel = (bits & VIEW_CHANNEL) !== 0n;
    return {
      known: true,
      bits,
      canViewChannel,
      canSendMessages: canViewChannel && (bits & SEND_MESSAGES) !== 0n,
      canEmbedLinks: canViewChannel && (bits & EMBED_LINKS) !== 0n,
      canConnect: canViewChannel && (bits & CONNECT) !== 0n,
      canSpeak: canViewChannel && (bits & SPEAK) !== 0n,
    };
  }

  _unknown(): PermissionResolution {
    return {
      known: false,
      bits: null,
      canViewChannel: false,
      canSendMessages: false,
      canEmbedLinks: false,
      canConnect: false,
      canSpeak: false,
    };
  }

  _cacheAndReturnUnknown(cacheKey: string): PermissionResolution {
    const value = this._unknown();
    this._setCached(this.channelPermCache, cacheKey, value, this.maxChannelPermCacheSize);
    return value;
  }

  async _getGuildMember(guildId: string, userId: string): Promise<unknown> {
    if (!this.rest) return null;
    const key = `${guildId}:${userId}`;
    const cached = this._getCached(this.guildMemberCache, key);
    if (cached) return cached;
    const value = await this.rest.getGuildMember(guildId, userId);
    this._setCached(this.guildMemberCache, key, value, this.maxGuildMemberCacheSize);
    return value;
  }

  async _getGuild(guildId: string): Promise<unknown> {
    if (!this.rest) return null;
    const key = String(guildId);
    const cached = this._getCached(this.guildCache, key);
    if (cached) return cached;
    const value = await this.rest.getGuild(guildId);
    this._setCached(this.guildCache, key, value, this.maxGuildCacheSize);
    return value;
  }

  _getCached<T>(map: Map<string, CachedEntry<T>>, key: string): T | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  _setCached<T>(map: Map<string, CachedEntry<T>>, key: string, value: T, maxSize: number): void {
    this._pruneExpiredEntries(map);
    map.delete(key);
    map.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    this._enforceCacheSizeLimit(map, maxSize);
  }

  _pruneExpiredEntries<T>(map: Map<string, CachedEntry<T>>): void {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        map.delete(key);
      }
    }
  }

  _enforceCacheSizeLimit<T>(map: Map<string, CachedEntry<T>>, maxSize: number): void {
    const safeMaxSize = Math.max(1, Number.parseInt(String(maxSize), 10) || 1);
    while (map.size > safeMaxSize) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }
}




