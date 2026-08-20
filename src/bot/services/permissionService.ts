import {
  ALL_PERMISSIONS,
  PERMISSION_FLAGS,
  hasPermission,
  type PermissionFlag,
} from '../permissions/flags.ts';
import {
  checkResolution,
  resolveMemberPermissions,
  unknownResolution,
  type ChannelPayload,
  type GuildPayload,
  type MemberPayload,
  type PermissionCheck,
  type PermissionResolution,
} from '../permissions/resolver.ts';

type CachedEntry<T> = {
  value: T;
  expiresAt: number;
};

type PermissionServiceOptions = {
  rest?: {
    getChannel: (channelId: string) => Promise<unknown>;
    getGuildMember: (guildId: string, userId: string) => Promise<unknown>;
    getGuild: (guildId: string) => Promise<unknown>;
    listGuildRoles?: (guildId: string) => Promise<unknown>;
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

  async checkBotPermissions(
    guildId: unknown,
    channelId: unknown,
    required: readonly PermissionFlag[]
  ): Promise<PermissionCheck> {
    const resolution = await this.resolveBotPermissions(guildId, channelId);
    return checkResolution(resolution, required);
  }

  async checkMemberPermissions(
    guildId: unknown,
    channelId: unknown,
    userId: unknown,
    required: readonly PermissionFlag[]
  ): Promise<PermissionCheck> {
    const resolution = await this.resolveMemberPermissions(guildId, channelId, userId);
    return checkResolution(resolution, required);
  }

  async resolveBotPermissions(guildId: unknown, channelId: unknown): Promise<PermissionResolution> {
    if (!this.botUserId) return unknownResolution('no_user');
    return this.resolveMemberPermissions(guildId, channelId, this.botUserId);
  }

  async resolveMemberPermissions(
    guildId: unknown,
    channelId: unknown,
    userId: unknown
  ): Promise<PermissionResolution> {
    const safeGuildId = String(guildId ?? '').trim();
    const safeChannelId = String(channelId ?? '').trim();
    const safeUserId = String(userId ?? '').trim();

    if (!safeGuildId || !safeChannelId || !safeUserId) return unknownResolution('missing_ids');
    if (!this.rest) return unknownResolution('no_rest');

    const cacheKey = `${safeGuildId}:${safeChannelId}:${safeUserId}`;
    const cached = this._getCached(this.channelPermCache, cacheKey);
    if (cached) return cached;

    const resolution = await this._resolveUncached(safeGuildId, safeChannelId, safeUserId);
    this._setCached(this.channelPermCache, cacheKey, resolution, this.maxChannelPermCacheSize);
    return resolution;
  }

  async _resolveUncached(
    guildId: string,
    channelId: string,
    userId: string
  ): Promise<PermissionResolution> {
    const [memberResult, guildResult, channelResult] = await Promise.all([
      this._safeCall(() => this._getGuildMember(guildId, userId), 'getGuildMember', { guildId, userId }),
      this._safeCall(() => this._getGuild(guildId), 'getGuild', { guildId }),
      this._safeCall(() => this.rest!.getChannel(channelId), 'getChannel', { channelId }),
    ]);

    if (!guildResult.ok || !guildResult.value) return unknownResolution('guild_unavailable');

    const guild = await this._withGuildRoles(guildId, guildResult.value as GuildPayload);
    const ownerId = String(guild.owner_id ?? guild.ownerId ?? '').trim();
    const isOwner = Boolean(ownerId) && ownerId === userId;

    if (!isOwner) {
      if (!memberResult.ok || !memberResult.value) return unknownResolution('member_unavailable');
      if (!Array.isArray(guild.roles) || !guild.roles.length) return unknownResolution('roles_unavailable');
      if (!channelResult.ok || !channelResult.value) return unknownResolution('channel_unavailable');
    }

    return resolveMemberPermissions({
      member: (memberResult.value ?? null) as MemberPayload | null,
      guild,
      channel: (channelResult.value ?? null) as ChannelPayload | null,
      userId,
    });
  }

  async _safeCall<T>(
    fn: () => Promise<T>,
    label: string,
    meta: Record<string, unknown>
  ): Promise<{ ok: boolean; value: T | null }> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      this.logger?.debug?.('Permission lookup failed', {
        ...meta,
        call: label,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, value: null };
    }
  }

  async _withGuildRoles(guildId: string, guild: GuildPayload): Promise<GuildPayload> {
    const resolved: GuildPayload = { ...guild, id: guild?.id ?? guildId };
    if (Array.isArray(resolved.roles) && resolved.roles.length) return resolved;
    if (!this.rest?.listGuildRoles) return resolved;

    const listed = await this._safeCall(
      () => this.rest!.listGuildRoles!(guildId),
      'listGuildRoles',
      { guildId }
    );
    if (Array.isArray(listed.value) && listed.value.length) {
      resolved.roles = listed.value as NonNullable<GuildPayload['roles']>;
    }

    return resolved;
  }

  async canBotSendMessages(guildId: unknown, channelId: unknown): Promise<boolean | null> {
    return this._legacyCheck(guildId, channelId, ['VIEW_CHANNEL', 'SEND_MESSAGES']);
  }

  async canBotJoinAndSpeak(guildId: unknown, channelId: unknown): Promise<boolean | null> {
    return this._legacyCheck(guildId, channelId, ['VIEW_CHANNEL', 'CONNECT', 'SPEAK']);
  }

  async canBotMoveMembers(guildId: unknown, channelId: unknown): Promise<boolean | null> {
    return this._legacyCheck(guildId, channelId, ['VIEW_CHANNEL', 'MOVE_MEMBERS']);
  }

  async _legacyCheck(
    guildId: unknown,
    channelId: unknown,
    required: readonly PermissionFlag[]
  ): Promise<boolean | null> {
    const check = await this.checkBotPermissions(guildId, channelId, required);
    if (!check.known) return null;
    return check.ok;
  }

  async getBotChannelPermissions(guildId: unknown, channelId: unknown) {
    const resolution = await this.resolveBotPermissions(guildId, channelId);
    const bits = resolution.bits ?? 0n;
    const admin = resolution.isAdministrator;
    const canViewChannel = resolution.known && (admin || hasPermission(bits, 'VIEW_CHANNEL'));
    const has = (flag: PermissionFlag) => canViewChannel && (admin || hasPermission(bits, flag));

    return {
      known: resolution.known,
      bits: resolution.bits,
      reason: resolution.reason,
      canViewChannel,
      canSendMessages: has('SEND_MESSAGES'),
      canEmbedLinks: has('EMBED_LINKS'),
      canConnect: has('CONNECT'),
      canSpeak: has('SPEAK'),
      canMoveMembers: has('MOVE_MEMBERS'),
    };
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
}

export { ALL_PERMISSIONS, PERMISSION_FLAGS };
export type { PermissionCheck, PermissionFlag, PermissionResolution };
