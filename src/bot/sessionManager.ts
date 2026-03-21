import { EventEmitter } from 'events';
import { VoiceConnection } from '../voice/VoiceConnection.ts';
import { MusicPlayer } from '../player/MusicPlayer.ts';
import type {
  GuildConfig,
  GuildConfigStoreLike,
  LibraryStoreLike,
  RestAdapterLike,
  Session,
  SessionManagerOptions,
  SessionSnapshotDocument,
  SessionSelector,
  Track,
  VoiceStateStoreLike,
} from '../types/domain.ts';
import {
  createSessionKey,
  hasPendingTracks,
  normalizeSessionChannelId,
  now,
  settingsFromGuildConfig,
  toChannelId,
  toRoleSet,
} from './sessionManager/runtimeHelpers.ts';
import { runtimeMethods } from './sessionManager/runtimeMethods.ts';

export class SessionManager extends EventEmitter {
  [key: string]: unknown;
  declare _startSnapshotFlushLoop: () => void;
  declare _loadGuildConfig: (guildId: string) => Promise<GuildConfig | null>;
  declare _loadVoiceProfileSettings: (
    guildId: unknown,
    voiceChannelId: unknown
  ) => Promise<NonNullable<Session['voiceProfileSettings']>>;
  declare _hasSessionInstance: (session: unknown) => boolean;
  declare _isSessionPlaybackActive: (session: unknown) => boolean;
  declare _clearIdleTimer: (session: unknown) => void;
  declare _resetVoteState: (session: unknown, trackId?: string | null) => void;
  declare _startPlaybackDiagnostics: (session: unknown) => void;
  declare _stopPlaybackDiagnostics: (session: unknown) => void;
  declare _emitPlaybackDiagnosticsTick: (session: unknown) => Promise<void>;
  declare _hasHumanListeners: (session: unknown) => boolean;
  declare _countHumanListeners: (session: unknown) => number;
  declare markSnapshotDirty: (session: unknown, flushSoon?: boolean) => void;
  declare _scheduleIdleTimeout: (session: unknown) => void;
  declare flushDirtySnapshots: () => Promise<void>;
  declare buildSessionSnapshot: (session: unknown) => SessionSnapshotDocument | null;
  declare persistSessionSnapshot: (session: unknown, options?: Record<string, unknown>) => Promise<boolean>;
  declare restoreSessionSnapshot: (session: unknown) => Promise<boolean>;
  declare _restoreTrackFromSnapshot: (
    session: unknown,
    track: Partial<Track> | null | undefined,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  declare _inspectPersistentVoiceChannel: (
    guildId: string,
    voiceChannelId: string
  ) => Promise<'missing' | 'present' | 'unknown'>;
  declare _clearPersistentVoiceBinding: (guildId: string, voiceChannelId: string) => Promise<boolean>;
  declare _isPermanentPersistentVoiceFailure: (error: unknown) => boolean;
  declare _handleQueueEmpty: (session: unknown, event?: Record<string, unknown>) => Promise<void>;
  declare _isSnapshotTrackDirectlyPlayable: (track: unknown) => boolean;
  declare adoptVoiceChannel: (session: Session, channelId: unknown) => Session;
  gateway: SessionManagerOptions['gateway'];
  config: SessionManagerOptions['config'];
  logger: SessionManagerOptions['logger'] | undefined;
  guildConfigs: GuildConfigStoreLike | null;
  library: LibraryStoreLike | null;
  rest: RestAdapterLike | null;
  voiceStateStore: VoiceStateStoreLike | null;
  botUserId: string | null;
  sessions: Map<string, Session>;
  snapshotFlushHandle: NodeJS.Timeout | null;

  constructor(options: SessionManagerOptions) {
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

  _isSessionRestartRecoverable(session: Session | null | undefined): boolean {
    const player = session?.player ?? null;
    return Boolean(
      player?.playing
      || player?.currentTrack
      || hasPendingTracks(player)
    );
  }

  _syncPersistentVoiceStateSoon(guildId: string, reason = 'state_change'): void {
    this.syncPersistentVoiceState(guildId).catch((err) => {
      this.logger?.debug?.('Failed to sync persistent voice state', {
        guildId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  setBotUserId(botUserId: string | null | undefined): void {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  listByGuild(guildId: string): Session[] {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return [];
    return [...this.sessions.values()].filter((session) => session?.guildId === safeGuildId);
  }

  has(guildId: string, selector: SessionSelector | string | null = null): boolean {
    if (!selector) {
      return this.listByGuild(guildId).length > 0;
    }
    return Boolean(this.get(guildId, selector));
  }

  get(guildId: string, selector: SessionSelector | string | null = null): Session | null {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return null;

    const sessions = this.listByGuild(safeGuildId);
    if (sessions.length === 0) return null;

    const selectorObject = selector && typeof selector === 'object' ? selector : null;

    if (selector && typeof selector === 'object' && selector.sessionId) {
      const bySessionId = this.sessions.get(String(selector.sessionId)) ?? null;
      return bySessionId?.guildId === safeGuildId ? bySessionId : null;
    }

    const voiceChannelId = typeof selector === 'string'
      ? normalizeSessionChannelId(selector)
      : normalizeSessionChannelId(selectorObject?.voiceChannelId);
    if (voiceChannelId) {
      return sessions.find((session) => (
        session?.connection?.channelId === voiceChannelId
        || session?.targetVoiceChannelId === voiceChannelId
      )) ?? null;
    }

    const textChannelId = normalizeSessionChannelId(selectorObject?.textChannelId);
    if (textChannelId) {
      const matches = sessions.filter((session) => session?.textChannelId === textChannelId);
      if (matches.length === 1) return matches[0] ?? null;
    }

    if (sessions.length === 1) return sessions[0] ?? null;
    if (selectorObject?.allowAnyGuildSession) return sessions[0] ?? null;
    return null;
  }

  async ensure(guildId: string, guildConfig: GuildConfig | null = null, options: SessionSelector | null = null): Promise<Session> {
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

    const connectionLogger = this.logger?.child?.('voice') ?? this.logger ?? null;
    const connectionOptions: ConstructorParameters<typeof VoiceConnection>[2] = {
      ...(connectionLogger ? { logger: connectionLogger } : { logger: null }),
      ...(this.config.voiceMaxBitrate != null ? { voiceMaxBitrate: this.config.voiceMaxBitrate } : {}),
    };
    const connection = new VoiceConnection(this.gateway, guildId, connectionOptions);

    const playerLogger = this.logger?.child?.('player') ?? this.logger ?? null;
    const playerOptions: ConstructorParameters<typeof MusicPlayer>[1] = {
      ...(playerLogger ? { logger: playerLogger } : {}),
      ...(this.config.ffmpegBin != null ? { ffmpegBin: this.config.ffmpegBin } : {}),
      ...(this.config.ytdlpBin != null ? { ytdlpBin: this.config.ytdlpBin } : {}),
      ...(this.config.ytdlpCookiesFile != null ? { ytdlpCookiesFile: this.config.ytdlpCookiesFile } : {}),
      ...(this.config.ytdlpCookiesFromBrowser != null ? { ytdlpCookiesFromBrowser: this.config.ytdlpCookiesFromBrowser } : {}),
      ...(this.config.ytdlpYoutubeClient != null ? { ytdlpYoutubeClient: this.config.ytdlpYoutubeClient } : {}),
      ...(this.config.ytdlpExtraArgs != null ? { ytdlpExtraArgs: this.config.ytdlpExtraArgs } : {}),
      ...(this.config.youtubePlaylistResolver != null ? { youtubePlaylistResolver: this.config.youtubePlaylistResolver } : {}),
      ...(this.config.maxQueueSize != null ? { maxQueueSize: this.config.maxQueueSize } : {}),
      ...(this.config.maxPlaylistTracks != null ? { maxPlaylistTracks: this.config.maxPlaylistTracks } : {}),
      ...((resolvedGuildConfig?.settings?.volumePercent ?? this.config.defaultVolumePercent) != null
        ? { defaultVolumePercent: resolvedGuildConfig?.settings?.volumePercent ?? this.config.defaultVolumePercent }
        : {}),
      ...(this.config.minVolumePercent != null ? { minVolumePercent: this.config.minVolumePercent } : {}),
      ...(this.config.maxVolumePercent != null ? { maxVolumePercent: this.config.maxVolumePercent } : {}),
      ...(this.config.enableYtSearch != null ? { enableYtSearch: this.config.enableYtSearch } : {}),
      ...(this.config.enableYtPlayback != null ? { enableYtPlayback: this.config.enableYtPlayback } : {}),
      ...(this.config.enableSpotifyImport != null ? { enableSpotifyImport: this.config.enableSpotifyImport } : {}),
      ...(this.config.enableDeezerImport != null ? { enableDeezerImport: this.config.enableDeezerImport } : {}),
      ...(this.config.spotifyClientId != null ? { spotifyClientId: this.config.spotifyClientId } : {}),
      ...(this.config.spotifyClientSecret != null ? { spotifyClientSecret: this.config.spotifyClientSecret } : {}),
      ...(this.config.spotifyRefreshToken != null ? { spotifyRefreshToken: this.config.spotifyRefreshToken } : {}),
      ...(this.config.spotifyMarket != null ? { spotifyMarket: this.config.spotifyMarket } : {}),
      ...(this.config.soundcloudClientId != null ? { soundcloudClientId: this.config.soundcloudClientId } : {}),
      ...(this.config.soundcloudAutoClientId != null ? { soundcloudAutoClientId: this.config.soundcloudAutoClientId } : {}),
      ...(this.config.deezerArl != null ? { deezerArl: this.config.deezerArl } : {}),
    };
    const player = new MusicPlayer(connection, playerOptions);

    const session: Session = {
      sessionId: createSessionKey(guildId, voiceChannelId),
      guildId,
      targetVoiceChannelId: voiceChannelId,
      ...(voiceProfileSettings ? { voiceProfileSettings } : {}),
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
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session);
      this._syncPersistentVoiceStateSoon(guildId, 'tracks_added');
      this.emit('tracksAdded', { session, tracks });
    });

    player.on('trackStart', (track) => {
      if (!this._hasSessionInstance(session)) return;
      delete session.restoreState;
      session.idleTimeoutIgnoreListeners = false;
      this._clearIdleTimer(session);
      this._resetVoteState(session, track?.id ?? null);
      this._startPlaybackDiagnostics(session);
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_start');
      this.emit('trackStart', { session, track });
    });

    player.on('trackEnd', (event: Record<string, unknown> = {}) => {
      if (!this._hasSessionInstance(session)) return;
      if (!this._isSessionPlaybackActive(session)) {
        this._stopPlaybackDiagnostics(session);
      }
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_end');
      this.emit('trackEnd', { session, ...event });
    });

    player.on('trackError', ({ track, error }: { track: unknown; error: unknown }) => {
      if (!this._hasSessionInstance(session)) return;
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_error');
      const message = String((error as { message?: unknown } | null | undefined)?.message ?? '').toLowerCase();
      const playerState = session.player as { skipRequested?: unknown; pendingSeekTrack?: unknown } | null | undefined;
      if (
        session.restoreState?.suppressStartupErrors
        && message.includes('playback pipeline exited before audio output')
      ) {
        this.logger?.debug?.('Suppressing restore startup playback error emission', {
          guildId,
          sessionId: session.sessionId ?? null,
          trackTitle: String((track as { title?: unknown } | null | undefined)?.title ?? '').trim() || null,
          error: message,
        });
        return;
      }
      if (
        message.includes('playback pipeline exited before audio output')
        && (Boolean(playerState?.skipRequested) || Boolean(playerState?.pendingSeekTrack))
      ) {
        this.logger?.debug?.('Suppressing intentional restart startup playback error emission', {
          guildId,
          sessionId: session.sessionId ?? null,
          trackTitle: String((track as { title?: unknown } | null | undefined)?.title ?? '').trim() || null,
          skipRequested: Boolean(playerState?.skipRequested),
          hasPendingSeekTrack: Boolean(playerState?.pendingSeekTrack),
        });
        return;
      }
      this.emit('trackError', { session, track, error });
    });

    player.on('queueEmpty', (event: Record<string, unknown> = {}) => {
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
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'queue_empty');
      this._handleQueueEmpty(session, event).catch((err: unknown) => {
        this.logger?.warn?.('Queue empty handler failed', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.sessions.set(session.sessionId!, session);
    this._scheduleIdleTimeout(session);

    return session;
  }

  applyGuildConfig(guildId: string, guildConfig: GuildConfig | null) {
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

      if (previous.volumePercent !== session.settings.volumePercent && typeof session.settings.volumePercent === 'number') {
        session.player.setVolumePercent?.(session.settings.volumePercent);
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

    return sessions[0] ?? null;
  }

  async refreshVoiceProfileSettings(guildId: string, selector: SessionSelector | string | null = null) {
    const session = this.get(guildId, selector);
    if (!session) return null;

    const nextVoiceProfileSettings = await this._loadVoiceProfileSettings(
      session.guildId,
      session?.connection?.channelId ?? session?.targetVoiceChannelId ?? null
    );
    session.voiceProfileSettings = nextVoiceProfileSettings;
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

  bindTextChannel(guildId: string, channelId: string, selector: SessionSelector | string | null = null) {
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

  touch(guildId: string, selector: SessionSelector | string | null = null): void {
    const session = this.get(guildId, selector);
    if (!session) return;

    session.lastActivityAt = now();
  }

  setSetting(guildId: string, key: string, value: unknown) {
    const sessions = this.listByGuild(guildId);
    if (!sessions.length) return null;

    for (const session of sessions) {
      if (key === 'djRoleIds') {
        session.settings.djRoleIds = toRoleSet(value);
      } else {
        (session.settings as Record<string, unknown>)[key] = value;
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

    return (sessions[0]?.settings as Record<string, unknown> | undefined)?.[key];
  }

  async syncPersistentVoiceState(guildId: string): Promise<boolean> {
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

  async clearPersistentVoiceState(guildId: string): Promise<boolean> {
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

  clearVoteSkips(guildId: string, selector: SessionSelector | string | null = null): void {
    const session = this.get(guildId, selector);
    if (!session) return;
    const currentTrack = session.player.currentTrack as { id?: string | null } | null | undefined;
    this._resetVoteState(session, currentTrack?.id ?? null);
  }

  registerVoteSkip(guildId: string, userId: string, selector: SessionSelector | string | null = null) {
    const session = this.get(guildId, selector);
    if (!session) return null;

    const currentTrack = session.player.currentTrack as { id?: string | null } | null | undefined;
    const currentTrackId = currentTrack?.id ?? null;
    if (!currentTrackId) return null;

    if (session.votes!.trackId !== currentTrackId) {
      this._resetVoteState(session, currentTrackId);
    }

    const key = String(userId);
    const before = session.votes!.voters.size;
    session.votes!.voters.add(key);

    return {
      added: session.votes!.voters.size > before,
      votes: session.votes!.voters.size,
      trackId: currentTrackId,
    };
  }

  getVoteCount(guildId: string, selector: SessionSelector | string | null = null): number {
    const session = this.get(guildId, selector);
    if (!session) return 0;
    return session.votes!.voters.size;
  }

  async destroy(guildId: string, reason = 'manual', selector: SessionSelector | null = null): Promise<boolean> {
    const sessions = selector ? [this.get(guildId, selector)].filter((session): session is Session => session != null) : this.listByGuild(guildId);
    if (!sessions.length) return false;
    const skipSnapshotPersist = selector?.skipSnapshotPersist === true;

    for (const session of sessions) {
      if (reason === 'shutdown' && !skipSnapshotPersist) {
        await this.persistSessionSnapshot(session, { force: true }).catch(() => null);
      }

      const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
      this.sessions.delete(session.sessionId!);
      this._stopPlaybackDiagnostics(session);
      this._clearIdleTimer(session);

      try {
        session.player.stop?.();
      } catch {
        // ignore player stop errors during cleanup
      }

      await session.connection.disconnect?.().catch(() => null);
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

  async shutdown(): Promise<void> {
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
        sessionId: session.sessionId!,
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
        results.push({ guildId, voiceChannelId, textChannelId, restored: false, reason: 'voice_channel_missing' });
        continue;
      }

      const hadSession = this.has(guildId, { voiceChannelId });
      const session = await this.ensure(guildId, guildConfig, { voiceChannelId, textChannelId });
      if (textChannelId) {
        session.textChannelId = textChannelId;
      }

      if (session.connection.connected && session.connection.channelId === voiceChannelId) {
        await this.restoreSessionSnapshot(session).catch((err: unknown) => {
          this.logger?.warn?.('Failed to restore persistent playback snapshot', {
            guildId,
            channelId: voiceChannelId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        await this.syncPersistentVoiceState(guildId).catch(() => null);
        results.push({ guildId, voiceChannelId, textChannelId, restored: true, reason: 'already_connected' });
        continue;
      }

      try {
        if (typeof session.connection.connect !== 'function') {
          throw new Error('Session connection cannot connect.');
        }
        await session.connection.connect(voiceChannelId);
        await this.restoreSessionSnapshot(session).catch((err: unknown) => {
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
        results.push({ guildId, voiceChannelId, textChannelId, restored: true, reason: 'connected' });
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
          await this.destroy(guildId, 'restore_failed', { sessionId: session.sessionId! }).catch(() => null);
        }
        results.push({
          guildId,
          voiceChannelId,
          textChannelId,
          restored: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

}

Object.assign(SessionManager.prototype, runtimeMethods);




