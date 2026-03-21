import type { BivariantCallback, LoggerLike } from '../types/core.ts';

type VoiceStateWaiter = {
  resolve: (channelId: string | null) => void;
};

type VoiceStatePayload = {
  user_id?: string | null;
  channel_id?: string | null;
};

type GatewayPayload = {
  id?: string | null;
  guild_id?: string | null;
  guilds?: Array<{ id?: string | null; voice_states?: VoiceStatePayload[] | null }> | null;
  voice_states?: VoiceStatePayload[] | null;
};

type MessageLike = {
  guild_id?: string | null;
  user_id?: string | null;
  author?: { id?: string | null } | null;
  member?: Record<string, unknown> | null;
};

type RestLike = {
  getGuildMember?: (guildId: string, userId: string) => Promise<unknown>;
};

export class VoiceStateStore {
  logger: LoggerLike | undefined;
  guildVoiceStates: Map<string, Map<string, string>>;
  pendingWaiters: Map<string, VoiceStateWaiter[]>;

  constructor(logger?: LoggerLike) {
    this.logger = logger;
    this.guildVoiceStates = new Map();
    this.pendingWaiters = new Map();
  }

  register(gateway: { on: (event: string, listener: BivariantCallback<[GatewayPayload], void>) => void }) {
    gateway.on('READY', (payload: GatewayPayload) => {
      let guilds = 0;
      let states = 0;

      for (const guild of payload?.guilds ?? []) {
        const seeded = this._seedGuildStates(guild?.id, guild?.voice_states ?? undefined);
        if (seeded > 0) {
          guilds += 1;
          states += seeded;
        }
      }

      this.logger?.info?.('Voice state ready sync complete', {
        guilds,
        states,
      });
    });

    gateway.on('GUILD_CREATE', (payload: GatewayPayload) => {
      const guildId = payload?.id;
      const count = this._seedGuildStates(guildId, payload?.voice_states ?? undefined);
      this.logger?.debug?.('Voice state guild sync', { guildId, states: count });
    });

    gateway.on('VOICE_STATE_UPDATE', (payload: GatewayPayload & VoiceStatePayload) => {
      this._upsert(payload?.guild_id, payload?.user_id, payload?.channel_id ?? null);
    });

    gateway.on('GUILD_DELETE', (payload: GatewayPayload) => {
      const guildId = payload?.id ?? payload?.guild_id;
      if (!guildId) return;
      this.guildVoiceStates.delete(guildId);
    });
  }

  resolveMemberVoiceChannel(message: MessageLike) {
    const direct = this._voiceChannelFromMember(message?.member);

    if (direct) return direct;

    const guildId = this._guildIdFromMessage(message);
    const userId = this._userIdFromMessage(message);
    if (!guildId || !userId) return null;

    return this.guildVoiceStates.get(guildId)?.get(userId) ?? null;
  }

  async resolveMemberVoiceChannelWithFallback(message: MessageLike, rest: RestLike | null | undefined, timeoutMs: number = 2_000) {
    const direct = this.resolveMemberVoiceChannel(message);
    if (direct) return direct;

    const guildId = this._guildIdFromMessage(message);
    const userId = this._userIdFromMessage(message);
    if (!guildId || !userId) return null;

    if (rest?.getGuildMember) {
      try {
        const member = await rest.getGuildMember(guildId, userId);
        const fromMember = this._voiceChannelFromMember(member) ?? this._voiceChannelFromMember((member as { member?: unknown } | null | undefined)?.member);
        if (fromMember) {
          this._upsert(guildId, userId, fromMember);
          this.logger?.debug?.('Resolved member voice channel via REST fallback', {
            guildId,
            userId,
            channelId: fromMember,
          });
          return fromMember;
        }
      } catch (err) {
        this.logger?.debug?.('Voice channel REST fallback failed', {
          guildId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.waitForMemberVoiceChannel(guildId, userId, timeoutMs);
  }

  getGuildVoiceStateCount(guildId: string) {
    return this.guildVoiceStates.get(guildId)?.size ?? 0;
  }

  getUsersInChannel(guildId: string, channelId: string) {
    if (!guildId || !channelId) return [];

    const states = this.guildVoiceStates.get(guildId);
    if (!states) return [];

    const users = [];
    for (const [userId, userChannelId] of states.entries()) {
      if (userChannelId === channelId) {
        users.push(userId);
      }
    }
    return users;
  }

  countUsersInChannel(guildId: string, channelId: string, excludedUserIds: string[] = []) {
    const excluded = new Set((excludedUserIds ?? []).map((id) => String(id)));
    const users = this.getUsersInChannel(guildId, channelId);
    return users.filter((id) => !excluded.has(String(id))).length;
  }

  _seedGuildStates(guildId: string | null | undefined, states: VoiceStatePayload[] = []) {
    if (!guildId) return 0;

    const next = new Map<string, string>();
    for (const state of states ?? []) {
      if (!state?.user_id || !state?.channel_id) continue;
      next.set(state.user_id, state.channel_id);
    }

    this.guildVoiceStates.set(guildId, next);
    return next.size;
  }

  _upsert(guildId: string | null | undefined, userId: string | null | undefined, channelId: string | null | undefined) {
    if (!guildId || !userId) return;

    let map = this.guildVoiceStates.get(guildId);
    if (!map) {
      map = new Map();
      this.guildVoiceStates.set(guildId, map);
    }

    if (!channelId) {
      map.delete(userId);
      return;
    }

    map.set(userId, channelId);
    this._resolveWaiters(guildId, userId, channelId);
  }

  waitForMemberVoiceChannel(guildId: string, userId: string, timeoutMs: number = 2_000) {
    const gid = String(guildId ?? '').trim();
    const uid = String(userId ?? '').trim();
    if (!gid || !uid) return Promise.resolve(null);

    const cached = this.guildVoiceStates.get(gid)?.get(uid) ?? null;
    if (cached) return Promise.resolve(cached);

    const key = `${gid}:${uid}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._removeWaiter(key, waiter);
        resolve(null);
      }, timeoutMs);

      const waiter = {
        resolve: (channelId: string | null) => {
          clearTimeout(timeout);
          resolve(channelId);
        },
      };

      const list = this.pendingWaiters.get(key) ?? [];
      list.push(waiter);
      this.pendingWaiters.set(key, list);
    });
  }

  _resolveWaiters(guildId: string, userId: string, channelId: string) {
    const key = `${String(guildId)}:${String(userId)}`;
    const list = this.pendingWaiters.get(key);
    if (!list?.length) return;

    this.pendingWaiters.delete(key);
    for (const waiter of list) {
      try {
        waiter.resolve(channelId);
      } catch {
        // ignore waiter resolution errors
      }
    }
  }

  _removeWaiter(key: string, waiter: VoiceStateWaiter) {
    const list = this.pendingWaiters.get(key);
    if (!list?.length) return;

    const next = list.filter((entry) => entry !== waiter);
    if (next.length) {
      this.pendingWaiters.set(key, next);
    } else {
      this.pendingWaiters.delete(key);
    }
  }

  _voiceChannelFromMember(member: unknown) {
    const typed = (member ?? {}) as {
      voice_channel_id?: string | null;
      voice_state?: { channel_id?: string | null } | null;
      voice?: { channel_id?: string | null } | null;
    };
    return (
      typed.voice_channel_id ??
      typed.voice_state?.channel_id ??
      typed.voice?.channel_id ??
      null
    );
  }

  _guildIdFromMessage(message: MessageLike) {
    return message?.guild_id ?? null;
  }

  _userIdFromMessage(message: MessageLike) {
    const memberUserId = (message?.member as { user?: { id?: string | null } | null } | null | undefined)?.user?.id ?? null;
    return message?.author?.id ?? message?.user_id ?? memberUserId ?? null;
  }
}


