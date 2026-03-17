import { EventEmitter } from 'events';
import { VoiceConnection } from '../voice/VoiceConnection.js';
import { MusicPlayer } from '../player/MusicPlayer.js';
import { isHttpUrl, isYouTubeUrl } from '../player/musicPlayer/trackUtils.js';

function now() {
  return Date.now();
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toVolumePercent(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 200 ? parsed : fallback;
}

function toRatio(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function toRoleSet(value) {
  if (value instanceof Set) {
    return new Set([...value].map((id) => String(id)));
  }

  if (Array.isArray(value)) {
    return new Set(
      value
        .map((id) => String(id ?? '').trim())
        .filter((id) => /^\d{6,}$/.test(id))
    );
  }

  return new Set();
}

function toChannelId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return /^\d{6,}$/.test(normalized) ? normalized : null;
}

function normalizeSessionChannelId(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function hasPendingTracks(player) {
  const pendingTracks = player?.pendingTracks;
  if (Array.isArray(pendingTracks)) return pendingTracks.length > 0;
  return Number.parseInt(String(player?.queue?.pendingSize ?? 0), 10) > 0;
}

function cloneTrackForSnapshot(track, seekStartSec = 0) {
  if (!track || typeof track !== 'object') return null;
  return {
    title: track.title ?? 'Unknown title',
    url: track.url ?? null,
    duration: track.duration ?? 'Unknown',
    thumbnailUrl: track.thumbnailUrl ?? null,
    requestedBy: track.requestedBy ?? null,
    source: track.source ?? 'unknown',
    artist: track.artist ?? null,
    soundcloudTrackId: track.soundcloudTrackId ?? null,
    audiusTrackId: track.audiusTrackId ?? null,
    deezerTrackId: track.deezerTrackId ?? null,
    deezerPreviewUrl: track.deezerPreviewUrl ?? null,
    deezerFullStreamUrl: track.deezerFullStreamUrl ?? null,
    spotifyTrackId: track.spotifyTrackId ?? null,
    spotifyPreviewUrl: track.spotifyPreviewUrl ?? null,
    isPreview: track.isPreview === true,
    isLive: track.isLive === true,
    seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec ?? 0), 10) || 0),
  };
}

function buildSnapshotRestoreQuery(track) {
  const url = String(track?.url ?? '').trim();
  if (url) return url;

  const artist = String(track?.artist ?? '').trim();
  const title = String(track?.title ?? '').trim();
  if (artist && title) return `${artist} - ${title}`;
  return title || artist || '';
}

function isSnapshotTrackDirectlyPlayable(track) {
  if (!track || typeof track !== 'object') return false;

  const source = String(track.source ?? '').trim().toLowerCase();
  const url = String(track.url ?? '').trim();

  if (isYouTubeUrl(url)) return true;
  if (track?.deezerTrackId || source.startsWith('deezer')) return true;
  if (source.startsWith('audius')) return true;
  if (source.startsWith('soundcloud')) return true;
  if (track?.isLive || source.startsWith('radio')) return isHttpUrl(url);
  if ((source === 'http-audio' || source === 'url') && isHttpUrl(url)) return true;

  return false;
}

function createSessionKey(guildId, voiceChannelId = null) {
  const safeGuildId = String(guildId ?? '').trim();
  const safeVoiceChannelId = normalizeSessionChannelId(voiceChannelId);
  return safeVoiceChannelId
    ? `${safeGuildId}:${safeVoiceChannelId}`
    : `${safeGuildId}:preview`;
}

function defaultSettings(config) {
  return {
    dedupeEnabled: Boolean(config.defaultDedupeEnabled),
    stayInVoiceEnabled: Boolean(config.defaultStayInVoiceEnabled),
    volumePercent: toVolumePercent(config.defaultVolumePercent, 100),
    voteSkipRatio: toRatio(config.voteSkipRatio, 0.5),
    voteSkipMinVotes: toPositiveInt(config.voteSkipMinVotes, 2),
    djRoleIds: new Set(),
    musicLogChannelId: null,
  };
}

function normalizeVoiceProfileSettings(profile) {
  if (!profile || typeof profile !== 'object') {
    return {
      stayInVoiceEnabled: null,
    };
  }

  return {
    stayInVoiceEnabled: typeof profile.stayInVoiceEnabled === 'boolean'
      ? profile.stayInVoiceEnabled
      : null,
  };
}

function settingsFromGuildConfig(config, guildConfig, voiceProfileSettings = null) {
  const defaults = defaultSettings(config);
  const source = guildConfig?.settings ?? {};
  const profile = normalizeVoiceProfileSettings(voiceProfileSettings);

  return {
    dedupeEnabled: toBool(source.dedupeEnabled, defaults.dedupeEnabled),
    stayInVoiceEnabled: typeof profile.stayInVoiceEnabled === 'boolean'
      ? profile.stayInVoiceEnabled
      : defaults.stayInVoiceEnabled,
    volumePercent: toVolumePercent(source.volumePercent, defaults.volumePercent),
    voteSkipRatio: toRatio(source.voteSkipRatio, defaults.voteSkipRatio),
    voteSkipMinVotes: toPositiveInt(source.voteSkipMinVotes, defaults.voteSkipMinVotes),
    djRoleIds: toRoleSet(source.djRoleIds),
    musicLogChannelId: toChannelId(source.musicLogChannelId),
  };
}

export class SessionManager extends EventEmitter {
  constructor(options) {
    super();

    this.gateway = options.gateway;
    this.config = options.config;
    this.logger = options.logger;
    this.guildConfigs = options.guildConfigs ?? null;
    this.library = options.library ?? null;
    this.rest = options.rest ?? null;
    this.voiceStateStore = options.voiceStateStore ?? null;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;

    this.sessions = new Map();
    this.snapshotFlushHandle = null;
    this._startSnapshotFlushLoop();
  }

  _isSessionRestartRecoverable(session) {
    const player = session?.player ?? null;
    return Boolean(
      player?.playing
      || player?.currentTrack
      || hasPendingTracks(player)
    );
  }

  _syncPersistentVoiceStateSoon(guildId, reason = 'state_change') {
    this.syncPersistentVoiceState(guildId).catch((err) => {
      this.logger?.debug?.('Failed to sync persistent voice state', {
        guildId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  setBotUserId(botUserId) {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  listByGuild(guildId) {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return [];
    return [...this.sessions.values()].filter((session) => session?.guildId === safeGuildId);
  }

  has(guildId, selector = null) {
    if (!selector) {
      return this.listByGuild(guildId).length > 0;
    }
    return Boolean(this.get(guildId, selector));
  }

  get(guildId, selector = null) {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return null;

    const sessions = this.listByGuild(safeGuildId);
    if (sessions.length === 0) return null;

    if (selector && typeof selector === 'object' && selector.sessionId) {
      const bySessionId = this.sessions.get(String(selector.sessionId)) ?? null;
      return bySessionId?.guildId === safeGuildId ? bySessionId : null;
    }

    const voiceChannelId = typeof selector === 'string'
      ? normalizeSessionChannelId(selector)
      : normalizeSessionChannelId(selector?.voiceChannelId);
    if (voiceChannelId) {
      return sessions.find((session) => (
        session?.connection?.channelId === voiceChannelId
        || session?.targetVoiceChannelId === voiceChannelId
      )) ?? null;
    }

    const textChannelId = normalizeSessionChannelId(selector?.textChannelId);
    if (textChannelId) {
      const matches = sessions.filter((session) => session?.textChannelId === textChannelId);
      if (matches.length === 1) return matches[0];
    }

    if (sessions.length === 1) return sessions[0];
    if (selector?.allowAnyGuildSession) return sessions[0];
    return null;
  }

  async ensure(guildId, guildConfig = null, options = null) {
    const voiceChannelId = normalizeSessionChannelId(options?.voiceChannelId);
    const textChannelId = normalizeSessionChannelId(options?.textChannelId);
    const existing = this.get(guildId, {
      voiceChannelId,
      textChannelId,
      allowAnyGuildSession: !voiceChannelId && !textChannelId,
    });
    if (existing) {
      if (guildConfig) {
        this.applyGuildConfig(guildId, guildConfig);
      }
      return existing;
    }

    const resolvedGuildConfig = guildConfig ?? await this._loadGuildConfig(guildId);
    const voiceProfileSettings = await this._loadVoiceProfileSettings(guildId, voiceChannelId);

    const connection = new VoiceConnection(this.gateway, guildId, {
      logger: this.logger?.child?.('voice') ?? this.logger,
      voiceMaxBitrate: this.config.voiceMaxBitrate,
    });

    const player = new MusicPlayer(connection, {
      logger: this.logger?.child?.('player') ?? this.logger,
      ffmpegBin: this.config.ffmpegBin,
      ytdlpBin: this.config.ytdlpBin,
      ytdlpCookiesFile: this.config.ytdlpCookiesFile,
      ytdlpCookiesFromBrowser: this.config.ytdlpCookiesFromBrowser,
      ytdlpYoutubeClient: this.config.ytdlpYoutubeClient,
      ytdlpExtraArgs: this.config.ytdlpExtraArgs,
      youtubePlaylistResolver: this.config.youtubePlaylistResolver,
      maxQueueSize: this.config.maxQueueSize,
      maxPlaylistTracks: this.config.maxPlaylistTracks,
      defaultVolumePercent: resolvedGuildConfig?.settings?.volumePercent ?? this.config.defaultVolumePercent,
      minVolumePercent: this.config.minVolumePercent,
      maxVolumePercent: this.config.maxVolumePercent,
      enableYtSearch: this.config.enableYtSearch,
      enableYtPlayback: this.config.enableYtPlayback,
      enableSpotifyImport: this.config.enableSpotifyImport,
      enableDeezerImport: this.config.enableDeezerImport,
      spotifyClientId: this.config.spotifyClientId,
      spotifyClientSecret: this.config.spotifyClientSecret,
      spotifyRefreshToken: this.config.spotifyRefreshToken,
      spotifyMarket: this.config.spotifyMarket,
      soundcloudClientId: this.config.soundcloudClientId,
      soundcloudAutoClientId: this.config.soundcloudAutoClientId,
      deezerArl: this.config.deezerArl,
    });

    const session = {
      sessionId: createSessionKey(guildId, voiceChannelId),
      guildId,
      targetVoiceChannelId: voiceChannelId,
      voiceProfileSettings,
      connection,
      player,
      settings: settingsFromGuildConfig(this.config, resolvedGuildConfig, voiceProfileSettings),
      votes: {
        trackId: null,
        voters: new Set(),
      },
      createdAt: now(),
      lastActivityAt: now(),
      textChannelId: null,
      idleTimer: null,
      idleTimeoutIgnoreListeners: false,
      diagnostics: {
        timer: null,
        inFlight: false,
      },
      snapshot: {
        dirty: false,
        lastPersistAt: 0,
        inFlight: false,
      },
    };

    player.on('tracksAdded', (tracks) => {
      if (!this._hasSessionInstance(session)) return;
      this.touch(guildId, { sessionId: session.sessionId });
      this.markSnapshotDirty(session);
      this._syncPersistentVoiceStateSoon(guildId, 'tracks_added');
      this.emit('tracksAdded', { session, tracks });
    });

    player.on('trackStart', (track) => {
      if (!this._hasSessionInstance(session)) return;
      session.idleTimeoutIgnoreListeners = false;
      this._clearIdleTimer(session);
      this._resetVoteState(session, track?.id ?? null);
      this._startPlaybackDiagnostics(session);
      this.touch(guildId, { sessionId: session.sessionId });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_start');
      this.emit('trackStart', { session, track });
    });

    player.on('trackEnd', (event) => {
      if (!this._hasSessionInstance(session)) return;
      if (!this._isSessionPlaybackActive(session)) {
        this._stopPlaybackDiagnostics(session);
      }
      this.touch(guildId, { sessionId: session.sessionId });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_end');
      this.emit('trackEnd', { session, ...event });
    });

    player.on('trackError', ({ track, error }) => {
      if (!this._hasSessionInstance(session)) return;
      this.touch(guildId, { sessionId: session.sessionId });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_error');
      this.emit('trackError', { session, track, error });
    });

    player.on('queueEmpty', (event = {}) => {
      if (!this._hasSessionInstance(session)) return;
      const trackActive = Boolean(session?.player?.playing || session?.player?.currentTrack);
      if (trackActive) {
        this.logger?.debug?.('Ignoring queueEmpty event while playback is still active', {
          guildId,
          playing: Boolean(session?.player?.playing),
          hasCurrentTrack: Boolean(session?.player?.currentTrack),
        });
        return;
      }

      this._stopPlaybackDiagnostics(session);
      this.touch(guildId, { sessionId: session.sessionId });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'queue_empty');
      this._handleQueueEmpty(session, event).catch((err) => {
        this.logger?.warn?.('Queue empty handler failed', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.sessions.set(session.sessionId, session);
    this._scheduleIdleTimeout(session);

    return session;
  }

  applyGuildConfig(guildId, guildConfig) {
    const sessions = this.listByGuild(guildId);
    if (!sessions.length) return null;

    let stayInVoiceChanged = false;
    for (const session of sessions) {
      const previous = session.settings;
      session.settings = settingsFromGuildConfig(this.config, guildConfig, session.voiceProfileSettings);

      if (previous.stayInVoiceEnabled !== session.settings.stayInVoiceEnabled) {
        stayInVoiceChanged = true;
        if (session.settings.stayInVoiceEnabled) {
          this._clearIdleTimer(session);
        } else {
          this._scheduleIdleTimeout(session);
        }
      }

      if (previous.volumePercent !== session.settings.volumePercent) {
        session.player.setVolumePercent(session.settings.volumePercent);
        this.markSnapshotDirty(session, true);
      }
    }

    if (stayInVoiceChanged) {
      for (const session of sessions) {
        this.markSnapshotDirty(session, true);
      }
      this.syncPersistentVoiceState(guildId).catch((err) => {
        this.logger?.debug?.('Failed to sync persistent voice state after guild config apply', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return sessions[0];
  }

  async refreshVoiceProfileSettings(guildId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return null;

    session.voiceProfileSettings = await this._loadVoiceProfileSettings(
      session.guildId,
      session?.connection?.channelId ?? session?.targetVoiceChannelId ?? null
    );
    const previous = session.settings;
    const guildConfig = await this._loadGuildConfig(session.guildId);
    session.settings = settingsFromGuildConfig(this.config, guildConfig, session.voiceProfileSettings);

    if (previous.stayInVoiceEnabled !== session.settings.stayInVoiceEnabled) {
      if (session.settings.stayInVoiceEnabled) {
        this._clearIdleTimer(session);
      } else {
        this._scheduleIdleTimeout(session);
      }
      this.markSnapshotDirty(session, true);
      await this.syncPersistentVoiceState(session.guildId).catch(() => null);
    }

    return session;
  }

  bindTextChannel(guildId, channelId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return null;
    session.textChannelId = channelId;
    this.markSnapshotDirty(session);
    this.syncPersistentVoiceState(guildId).catch((err) => {
      this.logger?.debug?.('Failed to sync persistent voice state after text bind', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return session;
  }

  touch(guildId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return;

    session.lastActivityAt = now();
  }

  setSetting(guildId, key, value) {
    const sessions = this.listByGuild(guildId);
    if (!sessions.length) return null;

    for (const session of sessions) {
      if (key === 'djRoleIds') {
        session.settings.djRoleIds = toRoleSet(value);
      } else {
        session.settings[key] = value;
      }

      if (key === 'stayInVoiceEnabled') {
        if (value) {
          this._clearIdleTimer(session);
        } else {
          this._scheduleIdleTimeout(session);
        }
      }

      if (['stayInVoiceEnabled', 'volumePercent'].includes(key)) {
        this.markSnapshotDirty(session, true);
      }
    }

    if (key === 'stayInVoiceEnabled') {
      this.syncPersistentVoiceState(guildId).catch((err) => {
        this.logger?.debug?.('Failed to sync persistent voice state after 24/7 update', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return sessions[0].settings[key];
  }

  async syncPersistentVoiceState(guildId) {
    if (!this.library?.patchGuildFeatureConfig) return false;

    const guildSessions = this.listByGuild(guildId);
    const persistentVoiceConnections = guildSessions
      .filter((session) => Boolean(session?.settings?.stayInVoiceEnabled))
      .map((session) => ({
        voiceChannelId: toChannelId(session?.connection?.channelId),
        textChannelId: toChannelId(session?.textChannelId),
      }))
      .filter((entry) => Boolean(entry.voiceChannelId));
    const restartRecoveryConnections = guildSessions
      .filter((session) => !session?.settings?.stayInVoiceEnabled && this._isSessionRestartRecoverable(session))
      .map((session) => ({
        voiceChannelId: toChannelId(session?.connection?.channelId),
        textChannelId: toChannelId(session?.textChannelId),
      }))
      .filter((entry) => Boolean(entry.voiceChannelId));

    const primary = persistentVoiceConnections[0] ?? null;

    await this.library.patchGuildFeatureConfig(guildId, {
      persistentVoiceConnections,
      restartRecoveryConnections,
      persistentVoiceChannelId: primary?.voiceChannelId ?? null,
      persistentTextChannelId: primary?.textChannelId ?? null,
      persistentVoiceUpdatedAt: new Date(),
    });

    return persistentVoiceConnections.length > 0 || restartRecoveryConnections.length > 0;
  }

  async clearPersistentVoiceState(guildId) {
    if (!this.library?.patchGuildFeatureConfig) return false;

    await this.library.patchGuildFeatureConfig(guildId, {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: new Date(),
    });

    return true;
  }

  clearVoteSkips(guildId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return;
    this._resetVoteState(session, session.player.currentTrack?.id ?? null);
  }

  registerVoteSkip(guildId, userId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return null;

    const currentTrackId = session.player.currentTrack?.id ?? null;
    if (!currentTrackId) return null;

    if (session.votes.trackId !== currentTrackId) {
      this._resetVoteState(session, currentTrackId);
    }

    const key = String(userId);
    const before = session.votes.voters.size;
    session.votes.voters.add(key);

    return {
      added: session.votes.voters.size > before,
      votes: session.votes.voters.size,
      trackId: currentTrackId,
    };
  }

  getVoteCount(guildId, selector = null) {
    const session = this.get(guildId, selector);
    if (!session) return 0;
    return session.votes.voters.size;
  }

  async destroy(guildId, reason = 'manual', selector = null) {
    const sessions = selector ? [this.get(guildId, selector)].filter(Boolean) : this.listByGuild(guildId);
    if (!sessions.length) return false;
    const skipSnapshotPersist = selector?.skipSnapshotPersist === true;

    for (const session of sessions) {
      if (reason === 'shutdown' && !skipSnapshotPersist) {
        await this.persistSessionSnapshot(session, { force: true }).catch(() => null);
      }

      const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
      this.sessions.delete(session.sessionId);
      this._stopPlaybackDiagnostics(session);
      this._clearIdleTimer(session);

      try {
        session.player.stop();
      } catch {
        // ignore player stop errors during cleanup
      }

      await session.connection.disconnect().catch(() => null);
      this.emit('destroyed', { session, reason });

      if (reason !== 'shutdown' && voiceChannelId) {
        await this.library?.deleteSessionSnapshot?.(session.guildId, voiceChannelId).catch(() => null);
      }
    }

    if (reason === 'shutdown') {
      return true;
    }

    await this.syncPersistentVoiceState(guildId).catch((err) => {
      this.logger?.debug?.('Failed to sync persistent voice state during session destroy', {
        guildId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return true;
  }

  async shutdown() {
    const sessions = [...this.sessions.values()];
    const guildIds = [...new Set(sessions.map((session) => String(session?.guildId ?? '').trim()).filter(Boolean))];

    for (const session of sessions) {
      await this.persistSessionSnapshot(session, { force: true }).catch(() => null);
    }

    for (const guildId of guildIds) {
      await this.syncPersistentVoiceState(guildId).catch(() => null);
    }

    for (const session of sessions) {
      if (!this._hasSessionInstance(session)) continue;
      await this.destroy(session.guildId, 'shutdown', {
        sessionId: session.sessionId,
        skipSnapshotPersist: true,
      });
    }
  }

  async restorePersistentVoiceSessions() {
    if (!this.library?.listPersistentVoiceConnections) return [];

    const bindings = await this.library.listPersistentVoiceConnections().catch((err) => {
      this.logger?.warn?.('Failed to load persistent voice bindings', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });

    const results = [];
    for (const binding of bindings) {
      const guildId = String(binding?.guildId ?? '').trim();
      const voiceChannelId = toChannelId(binding?.voiceChannelId);
      const textChannelId = normalizeSessionChannelId(binding?.textChannelId);
      if (!guildId || !voiceChannelId) continue;

      const guildConfig = await this._loadGuildConfig(guildId);

      const channelState = await this._inspectPersistentVoiceChannel(guildId, voiceChannelId);
      if (channelState === 'missing') {
        await this._clearPersistentVoiceBinding(guildId, voiceChannelId).catch(() => null);
        results.push({ guildId, restored: false, reason: 'voice_channel_missing' });
        continue;
      }

      const hadSession = this.has(guildId, { voiceChannelId });
      const session = await this.ensure(guildId, guildConfig, { voiceChannelId, textChannelId });
      if (textChannelId) {
        session.textChannelId = textChannelId;
      }

      if (session.connection.connected && session.connection.channelId === voiceChannelId) {
        await this.restoreSessionSnapshot(session).catch((err) => {
          this.logger?.warn?.('Failed to restore persistent playback snapshot', {
            guildId,
            channelId: voiceChannelId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        await this.syncPersistentVoiceState(guildId).catch(() => null);
        results.push({ guildId, restored: true, reason: 'already_connected' });
        continue;
      }

      try {
        await session.connection.connect(voiceChannelId);
        await this.restoreSessionSnapshot(session).catch((err) => {
          this.logger?.warn?.('Failed to restore persistent playback snapshot', {
            guildId,
            channelId: voiceChannelId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        await this.syncPersistentVoiceState(guildId).catch(() => null);
        this.logger?.info?.('Restored persistent voice session', {
          guildId,
          channelId: voiceChannelId,
          textChannelId,
        });
        results.push({ guildId, restored: true, reason: 'connected' });
      } catch (err) {
        this.logger?.warn?.('Failed to restore persistent voice session', {
          guildId,
          channelId: voiceChannelId,
          error: err instanceof Error ? err.message : String(err),
        });

        if (this._isPermanentPersistentVoiceFailure(err)) {
          await this._clearPersistentVoiceBinding(guildId, voiceChannelId).catch(() => null);
        }

        if (!hadSession) {
          await this.destroy(guildId, 'restore_failed', { sessionId: session.sessionId }).catch(() => null);
        }
        results.push({
          guildId,
          restored: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  async _inspectPersistentVoiceChannel(guildId, voiceChannelId) {
    if (!this.rest?.getChannel) return 'unknown';

    try {
      const channel = await this.rest.getChannel(voiceChannelId);
      const channelGuildId = String(channel?.guild_id ?? channel?.guildId ?? '').trim();
      if (channelGuildId && channelGuildId !== String(guildId)) {
        return 'missing';
      }
      return channel ? 'present' : 'unknown';
    } catch (err) {
      const status = Number(err?.status ?? 0);
      const message = String(err?.message ?? '').toLowerCase();
      if (
        status === 403
        || status === 404
        || message.includes('unknown channel')
        || message.includes('missing access')
        || message.includes('missing permissions')
      ) {
        return 'missing';
      }
      return 'unknown';
    }
  }

  _isPermanentPersistentVoiceFailure(error) {
    const status = Number(error?.status ?? 0);
    const message = String(error?.message ?? '').toLowerCase();
    return (
      status === 403
      || status === 404
      || message.includes('unknown channel')
      || message.includes('missing access')
      || message.includes('missing permissions')
      || message.includes('channel not found')
      || message.includes('unknown voice state')
    );
  }

  async _clearPersistentVoiceBinding(guildId, voiceChannelId) {
    if (!this.library?.getGuildFeatureConfig || !this.library?.patchGuildFeatureConfig) {
      return false;
    }

    const config = await this.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!config) return false;

    const bindings = Array.isArray(config.persistentVoiceConnections)
      ? config.persistentVoiceConnections
      : [];
    const nextBindings = bindings.filter((entry) => String(entry?.voiceChannelId ?? '').trim() !== String(voiceChannelId));
    const recoveryBindings = Array.isArray(config.restartRecoveryConnections)
      ? config.restartRecoveryConnections
      : [];
    const nextRecoveryBindings = recoveryBindings.filter((entry) => (
      String(entry?.voiceChannelId ?? '').trim() !== String(voiceChannelId)
    ));
    const primary = nextBindings[0] ?? null;

    await this.library.patchGuildFeatureConfig(guildId, {
      persistentVoiceConnections: nextBindings,
      restartRecoveryConnections: nextRecoveryBindings,
      persistentVoiceChannelId: primary?.voiceChannelId ?? null,
      persistentTextChannelId: primary?.textChannelId ?? null,
      persistentVoiceUpdatedAt: new Date(),
    });

    await this.library.deleteSessionSnapshot?.(guildId, voiceChannelId).catch(() => null);
    return true;
  }

  async _handleQueueEmpty(session, event = {}) {
    this.emit('queueEmpty', { session, ...event });

    if (session.settings.stayInVoiceEnabled) {
      session.idleTimeoutIgnoreListeners = false;
      this._clearIdleTimer(session);
      return;
    }

    // Queue end should disconnect after idle timeout even if users remain in VC.
    session.idleTimeoutIgnoreListeners = true;
    this._scheduleIdleTimeout(session);
  }

  async _loadGuildConfig(guildId) {
    if (!this.guildConfigs) return null;

    try {
      return await this.guildConfigs.get(guildId);
    } catch (err) {
      this.logger?.warn?.('Failed to load guild config for session bootstrap', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  _resetVoteState(session, trackId = null) {
    session.votes.trackId = trackId;
    session.votes.voters = new Set();
  }

  _scheduleIdleTimeout(session) {
    this._clearIdleTimer(session);

    if (this.config.sessionIdleMs <= 0) return;
    if (session.settings.stayInVoiceEnabled) return;

    session.idleTimer = setTimeout(async () => {
      const guildSessions = this.listByGuild(session.guildId);
      if (!this._hasSessionInstance(session) && guildSessions.length > 0) {
        // Stale timer from an older session instance; ignore.
        return;
      }

      const active = this._isSessionPlaybackActive(session);
      const hasHumanListeners = session.idleTimeoutIgnoreListeners
        ? false
        : this._hasHumanListeners(session);
      if (active || hasHumanListeners || session.settings.stayInVoiceEnabled) {
        this._scheduleIdleTimeout(session);
        return;
      }

      this.logger?.info?.('Destroying idle guild session', {
        guildId: session.guildId,
        sessionId: session.sessionId,
        idleMs: this.config.sessionIdleMs,
      });

      await this.destroy(session.guildId, 'idle_timeout', { sessionId: session.sessionId });
    }, this.config.sessionIdleMs);
  }

  _isSessionPlaybackActive(session) {
    const player = session?.player ?? null;
    const connection = session?.connection ?? null;

    const isPlayingFlag = Boolean(player?.playing);
    const hasCurrentTrack = Boolean(player?.currentTrack);
    const hasQueuedTracks = Number(player?.queue?.pendingSize ?? 0) > 0;
    const isStreaming = Boolean(connection?.isStreaming);

    return isPlayingFlag || hasCurrentTrack || hasQueuedTracks || isStreaming;
  }

  _hasHumanListeners(session) {
    const store = this.voiceStateStore;
    if (!store || typeof store.countUsersInChannel !== 'function') return false;

    const guildId = String(session?.guildId ?? '').trim();
    const channelId = String(session?.connection?.channelId ?? '').trim();
    if (!guildId || !channelId) return false;

    const listeners = this._countHumanListeners(session);
    return Number.isFinite(listeners) && listeners > 0;
  }

  _countHumanListeners(session) {
    const store = this.voiceStateStore;
    if (!store || typeof store.countUsersInChannel !== 'function') return 0;

    const guildId = String(session?.guildId ?? '').trim();
    const channelId = String(session?.connection?.channelId ?? '').trim();
    if (!guildId || !channelId) return 0;

    const excluded = this.botUserId ? [this.botUserId] : [];
    const listeners = store.countUsersInChannel(guildId, channelId, excluded);
    return Number.isFinite(listeners) ? listeners : 0;
  }

  _startPlaybackDiagnostics(session) {
    if (!this.config.playbackDiagnosticsEnabled) return;
    if (!session || session.diagnostics?.timer) return;

    const diagnostics = session.diagnostics ?? { timer: null, inFlight: false };
    session.diagnostics = diagnostics;

    const intervalMs = Math.max(250, Number.parseInt(String(this.config.playbackDiagnosticsIntervalMs ?? 1000), 10) || 1000);
    diagnostics.timer = setInterval(() => {
      this._emitPlaybackDiagnosticsTick(session).catch(() => null);
    }, intervalMs);
    diagnostics.timer.unref?.();

    this._emitPlaybackDiagnosticsTick(session).catch(() => null);
  }

  _stopPlaybackDiagnostics(session) {
    const diagnostics = session?.diagnostics;
    if (!diagnostics?.timer) return;

    clearInterval(diagnostics.timer);
    diagnostics.timer = null;
    diagnostics.inFlight = false;
  }

  async _emitPlaybackDiagnosticsTick(session) {
    if (!this.config.playbackDiagnosticsEnabled) return;
    if (!session || !this._hasSessionInstance(session)) return;

    const diagnostics = session.diagnostics ?? { timer: null, inFlight: false };
    session.diagnostics = diagnostics;

    if (diagnostics.inFlight) return;
    diagnostics.inFlight = true;

    try {
      const player = session.player;
      const connection = session.connection;
      const track = player?.currentTrack ?? null;
      const playerDiagnostics = typeof player?.getDiagnostics === 'function'
        ? player.getDiagnostics()
        : (typeof player?.getState === 'function' ? player.getState() : null);
      const voiceDiagnostics = typeof connection?.getDiagnostics === 'function'
        ? await connection.getDiagnostics()
        : {
            connected: Boolean(connection?.connected),
            isStreaming: Boolean(connection?.isStreaming),
            channelId: connection?.channelId ?? null,
          };

      this.logger?.info?.('Playback diagnostics', {
        guildId: session.guildId,
        channelId: connection?.channelId ?? null,
        listeners: this._countHumanListeners(session),
        track: track
          ? {
              id: track.id ?? null,
              title: track.title ?? null,
              source: track.source ?? null,
              url: track.url ?? null,
            }
          : null,
        player: playerDiagnostics,
        voice: voiceDiagnostics,
      });
    } finally {
      diagnostics.inFlight = false;
    }
  }

  _clearIdleTimer(session) {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  markSnapshotDirty(session, flushSoon = false) {
    if (!session?.snapshot) return;
    session.snapshot.dirty = true;
    if (flushSoon) {
      this.persistSessionSnapshot(session, { force: true }).catch(() => null);
    }
  }

  _startSnapshotFlushLoop() {
    if (this.snapshotFlushHandle) return;
    const intervalMs = Math.max(
      5_000,
      Number.parseInt(String(this.config.sessionSnapshotFlushIntervalMs ?? 30_000), 10) || 30_000
    );
    this.snapshotFlushHandle = setInterval(() => {
      this.flushDirtySnapshots().catch(() => null);
    }, intervalMs);
    this.snapshotFlushHandle.unref?.();
  }

  async flushDirtySnapshots() {
    for (const session of this.sessions.values()) {
      if (!session?.snapshot?.dirty) continue;
      await this.persistSessionSnapshot(session).catch(() => null);
    }
  }

  buildSessionSnapshot(session) {
    const player = session?.player ?? null;
    const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
    if (!session?.guildId || !voiceChannelId) return null;
    if (!session?.settings?.stayInVoiceEnabled && !this._isSessionRestartRecoverable(session)) return null;

    const currentTrack = player?.currentTrack ?? null;
    const progressSec = typeof player?.getProgressSeconds === 'function'
      ? player.getProgressSeconds()
      : 0;
    const canSeekCurrent = typeof player?.canSeekCurrentTrack === 'function'
      ? player.canSeekCurrentTrack()
      : false;

    return {
      guildId: session.guildId,
      voiceChannelId,
      textChannelId: toChannelId(session?.textChannelId),
      state: {
        playing: Boolean(player?.playing),
        paused: Boolean(player?.paused),
        loopMode: String(player?.loopMode ?? 'off'),
        volumePercent: Number.parseInt(String(player?.volumePercent ?? 100), 10) || 100,
        progressSec: Math.max(0, Number.parseInt(String(progressSec), 10) || 0),
      },
      currentTrack: cloneTrackForSnapshot(currentTrack, canSeekCurrent ? progressSec : 0),
      pendingTracks: Array.isArray(player?.pendingTracks)
        ? player.pendingTracks.map((track) => cloneTrackForSnapshot(track, 0)).filter(Boolean)
        : [],
      updatedAt: new Date(),
    };
  }

  async persistSessionSnapshot(session, options = {}) {
    if (!this.library?.upsertSessionSnapshot) return false;
    if (!session?.snapshot) return false;
    if (session.snapshot.inFlight) return false;

    const snapshot = this.buildSessionSnapshot(session);
    const voiceChannelId = snapshot?.voiceChannelId ?? toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
    if (!snapshot) {
      if (voiceChannelId) {
        await this.library.deleteSessionSnapshot?.(session.guildId, voiceChannelId).catch(() => null);
      }
      session.snapshot.dirty = false;
      return false;
    }

    const minIntervalMs = Math.max(
      1_000,
      Number.parseInt(String(this.config.sessionSnapshotMinWriteIntervalMs ?? 10_000), 10) || 10_000
    );
    if (!options.force && session.snapshot.lastPersistAt > 0 && (Date.now() - session.snapshot.lastPersistAt) < minIntervalMs) {
      session.snapshot.dirty = true;
      return false;
    }

    session.snapshot.inFlight = true;
    try {
      await this.library.upsertSessionSnapshot(session.guildId, snapshot.voiceChannelId, snapshot);
      session.snapshot.lastPersistAt = Date.now();
      session.snapshot.dirty = false;
      return true;
    } finally {
      session.snapshot.inFlight = false;
    }
  }

  async restoreSessionSnapshot(session) {
    const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
    if (!this.library?.getSessionSnapshot || !session?.guildId || !voiceChannelId) return false;

    const snapshot = await this.library.getSessionSnapshot(session.guildId, voiceChannelId).catch(() => null);
    if (!snapshot) return false;

    const state = snapshot.state ?? {};
    if (Number.isFinite(state.volumePercent)) {
      session.player.setVolumePercent(state.volumePercent);
    }
    if (state.loopMode) {
      session.player.setLoopMode(state.loopMode);
    }

    const currentTrack = snapshot.currentTrack
      ? await this._restoreTrackFromSnapshot(session, snapshot.currentTrack, {
          seekStartSec: state.progressSec,
        })
      : null;
    const pendingTracks = [];
    for (const track of Array.isArray(snapshot.pendingTracks) ? snapshot.pendingTracks : []) {
      const restored = await this._restoreTrackFromSnapshot(session, track);
      if (restored) pendingTracks.push(restored);
    }

    session.player.clearQueue();
    if (currentTrack) {
      session.player.enqueueResolvedTracks([currentTrack, ...pendingTracks], { dedupe: false });
      await session.player.play();
      if (state.paused) {
        session.player.pause();
      }
      this.markSnapshotDirty(session);
      return true;
    }

    if (pendingTracks.length) {
      session.player.enqueueResolvedTracks(pendingTracks, { dedupe: false });
      if (state.playing) {
        await session.player.play();
        if (state.paused) {
          session.player.pause();
        }
      }
      this.markSnapshotDirty(session);
      return true;
    }

    return false;
  }

  async _restoreTrackFromSnapshot(session, track, options = {}) {
    if (!session?.player || !track || typeof track !== 'object') return null;

    const seekStartSec = Math.max(
      0,
      Number.parseInt(String(options.seekStartSec ?? track?.seekStartSec ?? 0), 10) || 0
    );
    const requestedBy = track?.requestedBy ?? null;

    if (isSnapshotTrackDirectlyPlayable(track)) {
      return session.player.createTrackFromData({
        ...track,
        requestedBy,
        seekStartSec,
      });
    }

    const query = buildSnapshotRestoreQuery(track);
    if (!query || typeof session.player.previewTracks !== 'function') {
      return session.player.createTrackFromData({
        ...track,
        requestedBy,
        seekStartSec,
      });
    }

    try {
      const resolved = await session.player.previewTracks(query, {
        requestedBy,
        limit: 1,
      });
      const playable = Array.isArray(resolved) ? resolved[0] : null;
      if (playable) {
        return session.player.createTrackFromData({
          ...playable,
          requestedBy: playable?.requestedBy ?? requestedBy,
          seekStartSec,
        });
      }
    } catch (err) {
      this.logger?.debug?.('Failed to re-resolve snapshot track, falling back to stored track data', {
        guildId: session?.guildId ?? null,
        title: String(track?.title ?? '').trim() || null,
        source: String(track?.source ?? '').trim() || null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return session.player.createTrackFromData({
      ...track,
      requestedBy,
      seekStartSec,
    });
  }

  adoptVoiceChannel(session, channelId) {
    const voiceChannelId = normalizeSessionChannelId(channelId);
    if (!session || !voiceChannelId) return session;

    const nextSessionId = createSessionKey(session.guildId, voiceChannelId);
    session.targetVoiceChannelId = voiceChannelId;
    if (session.sessionId === nextSessionId) return session;

    this.sessions.delete(session.sessionId);
    session.sessionId = nextSessionId;
    this.sessions.set(session.sessionId, session);
    return session;
  }

  _hasSessionInstance(session) {
    if (!session) return false;
    if (session.sessionId && this.sessions.get(session.sessionId) === session) return true;
    return [...this.sessions.values()].includes(session);
  }

  async _loadVoiceProfileSettings(guildId, voiceChannelId) {
    const normalizedGuildId = String(guildId ?? '').trim();
    const normalizedVoiceChannelId = normalizeSessionChannelId(voiceChannelId);
    if (!normalizedGuildId || !normalizedVoiceChannelId || !this.library?.getVoiceProfile) {
      return normalizeVoiceProfileSettings(null);
    }

    const profile = await this.library.getVoiceProfile(normalizedGuildId, normalizedVoiceChannelId).catch(() => null);
    return normalizeVoiceProfileSettings(profile);
  }
}
