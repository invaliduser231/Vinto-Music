import { EventEmitter } from 'events';
import { VoiceConnection } from '../voice/VoiceConnection.js';
import { MusicPlayer } from '../player/MusicPlayer.js';

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

function defaultSettings(config) {
  return {
    dedupeEnabled: Boolean(config.defaultDedupeEnabled),
    stayInVoiceEnabled: Boolean(config.defaultStayInVoiceEnabled),
    voteSkipRatio: toRatio(config.voteSkipRatio, 0.5),
    voteSkipMinVotes: toPositiveInt(config.voteSkipMinVotes, 2),
    djRoleIds: new Set(),
    musicLogChannelId: null,
  };
}

function settingsFromGuildConfig(config, guildConfig) {
  const defaults = defaultSettings(config);
  const source = guildConfig?.settings ?? {};

  return {
    dedupeEnabled: toBool(source.dedupeEnabled, defaults.dedupeEnabled),
    stayInVoiceEnabled: toBool(source.stayInVoiceEnabled, defaults.stayInVoiceEnabled),
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
    this.voiceStateStore = options.voiceStateStore ?? null;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;

    this.sessions = new Map();
  }

  setBotUserId(botUserId) {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  has(guildId) {
    return this.sessions.has(guildId);
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  async ensure(guildId, guildConfig = null) {
    if (this.sessions.has(guildId)) {
      if (guildConfig) {
        this.applyGuildConfig(guildId, guildConfig);
      }

      const existing = this.sessions.get(guildId);
      this.touch(guildId);
      return existing;
    }

    const resolvedGuildConfig = guildConfig ?? await this._loadGuildConfig(guildId);

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
      defaultVolumePercent: this.config.defaultVolumePercent,
      minVolumePercent: this.config.minVolumePercent,
      maxVolumePercent: this.config.maxVolumePercent,
      enableYtSearch: this.config.enableYtSearch,
      enableYtPlayback: this.config.enableYtPlayback,
      enableSpotifyImport: this.config.enableSpotifyImport,
      enableDeezerImport: this.config.enableDeezerImport,
      soundcloudClientId: this.config.soundcloudClientId,
      soundcloudAutoClientId: this.config.soundcloudAutoClientId,
      deezerArl: this.config.deezerArl,
    });

    const session = {
      guildId,
      connection,
      player,
      settings: settingsFromGuildConfig(this.config, resolvedGuildConfig),
      votes: {
        trackId: null,
        voters: new Set(),
      },
      createdAt: now(),
      lastActivityAt: now(),
      textChannelId: null,
      idleTimer: null,
      diagnostics: {
        timer: null,
        inFlight: false,
      },
    };

    player.on('tracksAdded', (tracks) => {
      if (this.sessions.get(guildId) !== session) return;
      this.touch(guildId);
      this.emit('tracksAdded', { session, tracks });
    });

    player.on('trackStart', (track) => {
      if (this.sessions.get(guildId) !== session) return;
      this._clearIdleTimer(session);
      this._resetVoteState(session, track?.id ?? null);
      this._startPlaybackDiagnostics(session);
      this.touch(guildId);
      this.emit('trackStart', { session, track });
    });

    player.on('trackEnd', (event) => {
      if (this.sessions.get(guildId) !== session) return;
      if (!this._isSessionPlaybackActive(session)) {
        this._stopPlaybackDiagnostics(session);
      }
      this.touch(guildId);
      this.emit('trackEnd', { session, ...event });
    });

    player.on('trackError', ({ track, error }) => {
      if (this.sessions.get(guildId) !== session) return;
      this.touch(guildId);
      this.emit('trackError', { session, track, error });
    });

    player.on('queueEmpty', () => {
      if (this.sessions.get(guildId) !== session) return;
      if (this._isSessionPlaybackActive(session)) {
        this.logger?.debug?.('Ignoring queueEmpty event while playback is still active', {
          guildId,
          playing: Boolean(session?.player?.playing),
          hasCurrentTrack: Boolean(session?.player?.currentTrack),
          isStreaming: Boolean(session?.connection?.isStreaming),
        });
        return;
      }

      this._stopPlaybackDiagnostics(session);
      this.touch(guildId);
      this._handleQueueEmpty(session).catch((err) => {
        this.logger?.warn?.('Queue empty handler failed', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.sessions.set(guildId, session);
    this._scheduleIdleTimeout(session);

    return session;
  }

  applyGuildConfig(guildId, guildConfig) {
    const session = this.sessions.get(guildId);
    if (!session) return null;

    const previous = session.settings;
    session.settings = settingsFromGuildConfig(this.config, guildConfig);

    if (previous.stayInVoiceEnabled !== session.settings.stayInVoiceEnabled) {
      if (session.settings.stayInVoiceEnabled) {
        this._clearIdleTimer(session);
      } else {
        this._scheduleIdleTimeout(session);
      }
    }

    return session;
  }

  bindTextChannel(guildId, channelId) {
    const session = this.sessions.get(guildId);
    if (!session) return null;
    session.textChannelId = channelId;
    return session;
  }

  touch(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) return;

    session.lastActivityAt = now();
  }

  setSetting(guildId, key, value) {
    const session = this.sessions.get(guildId);
    if (!session) return null;

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

    return session.settings[key];
  }

  clearVoteSkips(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) return;
    this._resetVoteState(session, session.player.currentTrack?.id ?? null);
  }

  registerVoteSkip(guildId, userId) {
    const session = this.sessions.get(guildId);
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

  getVoteCount(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) return 0;
    return session.votes.voters.size;
  }

  async destroy(guildId, reason = 'manual') {
    const session = this.sessions.get(guildId);
    if (!session) return false;

    this.sessions.delete(guildId);
    this._stopPlaybackDiagnostics(session);
    this._clearIdleTimer(session);

    try {
      session.player.stop();
    } catch {
      // ignore player stop errors during cleanup
    }

    await session.connection.disconnect().catch(() => null);
    this.emit('destroyed', { session, reason });

    return true;
  }

  async shutdown() {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) {
      await this.destroy(guildId, 'shutdown');
    }
  }

  async _handleQueueEmpty(session) {
    this.emit('queueEmpty', { session });

    if (session.settings.stayInVoiceEnabled) {
      this._clearIdleTimer(session);
      return;
    }

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
      const currentSession = this.sessions.get(session.guildId);
      if (currentSession && currentSession !== session) {
        // Stale timer from an older session instance; ignore.
        return;
      }

      const active = this._isSessionPlaybackActive(session);
      const hasHumanListeners = this._hasHumanListeners(session);
      if (active || hasHumanListeners || session.settings.stayInVoiceEnabled) {
        this._scheduleIdleTimeout(session);
        return;
      }

      this.logger?.info?.('Destroying idle guild session', {
        guildId: session.guildId,
        idleMs: this.config.sessionIdleMs,
      });

      await this.destroy(session.guildId, 'idle_timeout');
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
    if (!session || !this.sessions.has(session.guildId)) return;

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
}
