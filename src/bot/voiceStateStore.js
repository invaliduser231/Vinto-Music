export class VoiceStateStore {
  constructor(logger) {
    this.logger = logger;
    this.guildVoiceStates = new Map();
  }

  register(gateway) {
    gateway.on('READY', (payload) => {
      let guilds = 0;
      let states = 0;

      for (const guild of payload?.guilds ?? []) {
        const seeded = this._seedGuildStates(guild?.id, guild?.voice_states);
        if (seeded > 0) {
          guilds += 1;
          states += seeded;
        }
      }

      this.logger.info('Voice state ready sync complete', {
        guilds,
        states,
      });
    });

    gateway.on('GUILD_CREATE', (payload) => {
      const guildId = payload?.id;
      const count = this._seedGuildStates(guildId, payload?.voice_states);
      this.logger.debug('Voice state guild sync', { guildId, states: count });
    });

    gateway.on('VOICE_STATE_UPDATE', (payload) => {
      this._upsert(payload?.guild_id, payload?.user_id, payload?.channel_id ?? null);
    });

    gateway.on('GUILD_DELETE', (payload) => {
      const guildId = payload?.id ?? payload?.guild_id;
      if (!guildId) return;
      this.guildVoiceStates.delete(guildId);
    });
  }

  resolveMemberVoiceChannel(message) {
    const direct =
      message?.member?.voice_channel_id ??
      message?.member?.voice_state?.channel_id ??
      message?.member?.voice?.channel_id ??
      null;

    if (direct) return direct;

    const guildId = message?.guild_id;
    const userId = message?.author?.id ?? message?.user_id ?? message?.member?.user?.id ?? null;
    if (!guildId || !userId) return null;

    return this.guildVoiceStates.get(guildId)?.get(userId) ?? null;
  }

  getGuildVoiceStateCount(guildId) {
    return this.guildVoiceStates.get(guildId)?.size ?? 0;
  }

  getUsersInChannel(guildId, channelId) {
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

  countUsersInChannel(guildId, channelId, excludedUserIds = []) {
    const excluded = new Set((excludedUserIds ?? []).map((id) => String(id)));
    const users = this.getUsersInChannel(guildId, channelId);
    return users.filter((id) => !excluded.has(String(id))).length;
  }

  _seedGuildStates(guildId, states = []) {
    if (!guildId) return 0;

    const next = new Map();
    for (const state of states ?? []) {
      if (!state?.user_id || !state?.channel_id) continue;
      next.set(state.user_id, state.channel_id);
    }

    this.guildVoiceStates.set(guildId, next);
    return next.size;
  }

  _upsert(guildId, userId, channelId) {
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
  }
}
