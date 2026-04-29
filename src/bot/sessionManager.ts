import { EventEmitter } from 'events';
import { VoiceConnection, type EarrapeDetectionEvent } from '../voice/VoiceConnection.ts';
import { MusicPlayer } from '../player/MusicPlayer.ts';
import type {
  GuildConfig,
  GuildConfigStoreLike,
  EarrapeProfileStoreLike,
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

const PERSISTENT_RESTORE_CONNECT_RETRY_ATTEMPTS = 3;
const PERSISTENT_RESTORE_CONNECT_RETRY_DELAY_MS = 250;

function isRetryablePersistentRestoreConnectFailure(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? '').toLowerCase();
  return message.includes('timeout waiting for voice_server_update');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type GatewayVoiceStateUpdate = {
  guild_id?: string | null;
  user_id?: string | null;
  channel_id?: string | null;
};

type PlayerSessionListeners = {
  tracksAdded: (...args: unknown[]) => void;
  trackStart: (...args: unknown[]) => void;
  trackEnd: (...args: unknown[]) => void;
  trackError: (...args: unknown[]) => void;
  queueEmpty: (...args: unknown[]) => void;
};

type ProcessMemoryTelemetry = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};
type SessionManagerMemoryTelemetry = {
  memory: ProcessMemoryTelemetry;
  sessionsTotal: number;
  voiceConnectionsConnected: number;
  playersPlaying: number;
  snapshotDirty: number;
  diagnosticsActive: number;
  idleTimersActive: number;
  playerListenerEntries: number;
  pendingTracksTotal: number;
};

function readProcessMemoryTelemetry(): ProcessMemoryTelemetry {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

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
  earrapeProfiles: EarrapeProfileStoreLike | null;
  rest: RestAdapterLike | null;
  voiceStateStore: VoiceStateStoreLike | null;
  botUserId: string | null;
  sessions: Map<string, Session>;
  snapshotFlushHandle: NodeJS.Timeout | null;
  playerSessionListeners: Map<string, PlayerSessionListeners>;

  constructor(options: SessionManagerOptions) {
    super();

    this.gateway = options.gateway;
    this.config = options.config;
    this.logger = options.logger;
    this.guildConfigs = options.guildConfigs ?? null;
    this.library = options.library ?? null;
    this.earrapeProfiles = options.earrapeProfiles ?? null;
    this.rest = options.rest ?? null;
    this.voiceStateStore = options.voiceStateStore ?? null;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;

    this.sessions = new Map();
    this.snapshotFlushHandle = null;
    this.playerSessionListeners = new Map();
    this._startSnapshotFlushLoop();
  }

  getMemoryTelemetry(): SessionManagerMemoryTelemetry {
    let voiceConnectionsConnected = 0;
    let playersPlaying = 0;
    let snapshotDirty = 0;
    let diagnosticsActive = 0;
    let idleTimersActive = 0;
    let pendingTracksTotal = 0;

    for (const session of this.sessions.values()) {
      if (session?.connection?.connected) voiceConnectionsConnected += 1;
      if (session?.player?.playing) playersPlaying += 1;
      if (session?.snapshot?.dirty) snapshotDirty += 1;
      if (session?.diagnostics?.timer) diagnosticsActive += 1;
      if (session?.idleTimer) idleTimersActive += 1;

      const queuePendingSize = Number.parseInt(String(session?.player?.queue?.pendingSize ?? ''), 10);
      if (Number.isFinite(queuePendingSize) && queuePendingSize > 0) {
        pendingTracksTotal += queuePendingSize;
      } else if (Array.isArray(session?.player?.pendingTracks)) {
        pendingTracksTotal += session.player.pendingTracks.length;
      }
    }

    return {
      memory: readProcessMemoryTelemetry(),
      sessionsTotal: this.sessions.size,
      voiceConnectionsConnected,
      playersPlaying,
      snapshotDirty,
      diagnosticsActive,
      idleTimersActive,
      playerListenerEntries: this.playerSessionListeners.size,
      pendingTracksTotal,
    };
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

  _isVoiceModerationPermissionError(error: unknown): boolean {
    const status = Number((error as { status?: unknown; statusCode?: unknown } | null | undefined)?.status ?? (
      error as { statusCode?: unknown } | null | undefined
    )?.statusCode ?? 0);
    const message = String((error as { message?: unknown } | null | undefined)?.message ?? '').toLowerCase();
    return (
      status === 403
      || message.includes('forbidden')
      || message.includes('missing permission')
      || message.includes('missing permissions')
      || message.includes('move members')
      || message.includes('insufficient permission')
    );
  }

  _resolveSessionNotificationChannel(session: Session | null | undefined): string | null {
    const channelId = String(session?.settings?.musicLogChannelId ?? session?.textChannelId ?? '').trim();
    return channelId || null;
  }

  async _notifySessionChannel(session: Session | null | undefined, message: string): Promise<boolean> {
    const sendMessage = this.rest?.sendMessage;
    const channelId = this._resolveSessionNotificationChannel(session);
    if (!channelId || typeof sendMessage !== 'function') return false;

    try {
      await sendMessage(channelId, message);
      return true;
    } catch (err) {
      this.logger?.debug?.('Failed to send session notification', {
        guildId: session?.guildId ?? null,
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async _handleEarrapeDetected(event: EarrapeDetectionEvent): Promise<void> {
    const guildId = String(event?.guildId ?? '').trim();
    const userId = String(event?.participantId ?? '').trim();
    const channelId = String(event?.channelId ?? '').trim() || null;
    if (!guildId || !userId) return;
    if (this.botUserId && userId === this.botUserId) return;

    const session = channelId
      ? this.get(guildId, { voiceChannelId: channelId, allowAnyGuildSession: true })
      : this.get(guildId, { allowAnyGuildSession: true });
    if (!session?.settings?.earrapeProtectionEnabled) return;

    const rest = this.rest;
    if (!rest || typeof rest.disconnectMemberFromVoice !== 'function') {
      this.logger?.warn?.('Earrape protection triggered without a voice-disconnect REST adapter', {
        guildId,
        channelId,
        participantId: userId,
      });
      await this._notifySessionChannel(
        session,
        `Earrape protection detected <@${userId}>, but I cannot disconnect users because the voice moderation API is unavailable.`
      );
      return;
    }

    try {
      await rest.disconnectMemberFromVoice(guildId, userId);
      this.logger?.warn?.('Disconnected member due to earrape protection trigger', {
        guildId,
        channelId,
        participantId: userId,
        peak: event.peak,
        threshold: event.threshold,
      });
      this.emit('earrapeDetected', { session, guildId, channelId, participantId: userId, peak: event.peak });
    } catch (err) {
      this.logger?.warn?.('Failed to disconnect member after earrape protection trigger', {
        guildId,
        channelId,
        participantId: userId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this._isVoiceModerationPermissionError(err)) {
        await this._notifySessionChannel(
          session,
          `Earrape protection detected <@${userId}>, but I am missing the **Move Members** permission and could not disconnect them.`
        );
      } else {
        await this._notifySessionChannel(
          session,
          `Earrape protection detected <@${userId}>, but disconnecting them failed due to an API error.`
        );
      }
    }
  }

  setBotUserId(botUserId: string | null | undefined): void {
    this.botUserId = botUserId ? String(botUserId) : null;
    for (const session of this.sessions.values()) {
      session.connection.setBotUserId?.(this.botUserId);
    }
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
    const initialSettings = settingsFromGuildConfig(this.config, resolvedGuildConfig, voiceProfileSettings);

    const connectionLogger = this.logger?.child?.('voice') ?? this.logger ?? null;
    const connectionOptions: ConstructorParameters<typeof VoiceConnection>[2] = {
      ...(connectionLogger ? { logger: connectionLogger } : { logger: null }),
      ...(this.config.voiceMaxBitrate != null ? { voiceMaxBitrate: this.config.voiceMaxBitrate } : {}),
      earrapeProtectionEnabled: Boolean(initialSettings.earrapeProtectionEnabled),
      botUserId: this.botUserId,
      earrapeProfileStore: this.earrapeProfiles,
      onEarrapeDetected: (event: EarrapeDetectionEvent) => this._handleEarrapeDetected(event),
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
      ...(this.config.ytdlpProxyUrl != null ? { ytdlpProxyUrl: this.config.ytdlpProxyUrl } : {}),
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
      ...(this.config.enableTidalImport != null ? { enableTidalImport: this.config.enableTidalImport } : {}),
      ...(this.config.nodeLinkEnabled != null ? { nodeLinkEnabled: this.config.nodeLinkEnabled } : {}),
      ...(this.config.nodeLinkBaseUrl != null ? { nodeLinkBaseUrl: this.config.nodeLinkBaseUrl } : {}),
      ...(this.config.nodeLinkPassword != null ? { nodeLinkPassword: this.config.nodeLinkPassword } : {}),
      ...(this.config.nodeLinkDefaultSearch != null ? { nodeLinkDefaultSearch: this.config.nodeLinkDefaultSearch } : {}),
      ...(this.config.nodeLinkRoutingMode != null ? { nodeLinkRoutingMode: this.config.nodeLinkRoutingMode } : {}),
      ...(this.config.nodeLinkRequestTimeoutMs != null ? { nodeLinkRequestTimeoutMs: this.config.nodeLinkRequestTimeoutMs } : {}),
      ...(this.config.nodeLinkStreamStartTimeoutMs != null ? { nodeLinkStreamStartTimeoutMs: this.config.nodeLinkStreamStartTimeoutMs } : {}),
      ...(this.config.spotifyClientId != null ? { spotifyClientId: this.config.spotifyClientId } : {}),
      ...(this.config.spotifyClientSecret != null ? { spotifyClientSecret: this.config.spotifyClientSecret } : {}),
      ...(this.config.spotifyRefreshToken != null ? { spotifyRefreshToken: this.config.spotifyRefreshToken } : {}),
      ...(this.config.spotifyMarket != null ? { spotifyMarket: this.config.spotifyMarket } : {}),
      ...(this.config.tidalToken != null ? { tidalToken: this.config.tidalToken } : {}),
      ...(this.config.tidalCountryCode != null ? { tidalCountryCode: this.config.tidalCountryCode } : {}),
      ...(this.config.appleMusicMediaApiToken != null ? { appleMusicMediaApiToken: this.config.appleMusicMediaApiToken } : {}),
      ...(this.config.appleMusicAutoToken != null ? { appleMusicAutoToken: this.config.appleMusicAutoToken } : {}),
      ...(this.config.appleMusicMarket != null ? { appleMusicMarket: this.config.appleMusicMarket } : {}),
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
      settings: initialSettings,
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

    const playerListeners: PlayerSessionListeners = {
      tracksAdded: (tracks) => {
      if (!this._hasSessionInstance(session)) return;
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session);
      this._syncPersistentVoiceStateSoon(guildId, 'tracks_added');
      this.emit('tracksAdded', { session, tracks });
      },

      trackStart: (track) => {
      const currentTrack = track as { id?: string | null } | null | undefined;
      if (!this._hasSessionInstance(session)) return;
      const restoredFromPersistentSession = Boolean(session.restoreState?.inProgress);
      delete session.restoreState;
      session.idleTimeoutIgnoreListeners = false;
      this._clearIdleTimer(session);
      this._resetVoteState(session, currentTrack?.id ?? null);
      this._startPlaybackDiagnostics(session);
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_start');
      this.emit('trackStart', { session, track, restoredFromPersistentSession });
      },

      trackEnd: (event = {}) => {
      const eventPayload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
      if (!this._hasSessionInstance(session)) return;
      if (!this._isSessionPlaybackActive(session)) {
        this._stopPlaybackDiagnostics(session);
      }
      this.touch(guildId, { sessionId: session.sessionId! });
      this.markSnapshotDirty(session, true);
      this._syncPersistentVoiceStateSoon(guildId, 'track_end');
      this.emit('trackEnd', { session, ...eventPayload });
      },

      trackError: (payload) => {
      const { track, error } = (payload && typeof payload === 'object'
        ? payload as { track: unknown; error: unknown }
        : { track: null, error: null });
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
      },

      queueEmpty: (event = {}) => {
      const eventPayload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
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
      this._handleQueueEmpty(session, eventPayload).catch((err: unknown) => {
        this.logger?.warn?.('Queue empty handler failed', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      },
    };

    player.on('tracksAdded', playerListeners.tracksAdded);
    player.on('trackStart', playerListeners.trackStart);
    player.on('trackEnd', playerListeners.trackEnd);
    player.on('trackError', playerListeners.trackError);
    player.on('queueEmpty', playerListeners.queueEmpty);

    this.sessions.set(session.sessionId!, session);
    this.playerSessionListeners.set(session.sessionId!, playerListeners);
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
      const earrapeProtectionEnabled = Boolean(session.settings.earrapeProtectionEnabled);
      if (Boolean(previous.earrapeProtectionEnabled) !== earrapeProtectionEnabled) {
        session.connection.setEarrapeProtectionEnabled?.(earrapeProtectionEnabled);
      }

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
    if (Boolean(previous.earrapeProtectionEnabled) !== Boolean(session.settings.earrapeProtectionEnabled)) {
      session.connection.setEarrapeProtectionEnabled?.(Boolean(session.settings.earrapeProtectionEnabled));
    }

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

      if (key === 'earrapeProtectionEnabled') {
        session.connection.setEarrapeProtectionEnabled?.(Boolean(value));
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

      this._detachPlayerListeners(session);

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

  _detachPlayerListeners(session: Session): void {
    const sessionId = String(session?.sessionId ?? '').trim();
    if (!sessionId) return;

    const listeners = this.playerSessionListeners.get(sessionId);
    this.playerSessionListeners.delete(sessionId);
    if (!listeners) return;

    const player = session.player as {
      off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
      removeAllListeners?: (event?: string) => unknown;
    } | null | undefined;
    if (!player) return;

    const detach = (event: string, listener: (...args: unknown[]) => void) => {
      if (typeof player.off === 'function') {
        player.off(event, listener);
        return;
      }
      if (typeof player.removeListener === 'function') {
        player.removeListener(event, listener);
        return;
      }
      player.removeAllListeners?.(event);
    };

    detach('tracksAdded', listeners.tracksAdded);
    detach('trackStart', listeners.trackStart);
    detach('trackEnd', listeners.trackEnd);
    detach('trackError', listeners.trackError);
    detach('queueEmpty', listeners.queueEmpty);
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
        let lastConnectError: unknown = null;
        for (let attempt = 1; attempt <= PERSISTENT_RESTORE_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
          try {
            await session.connection.connect(voiceChannelId);
            lastConnectError = null;
            break;
          } catch (err) {
            lastConnectError = err;
            const shouldRetry = (
              attempt < PERSISTENT_RESTORE_CONNECT_RETRY_ATTEMPTS
              && isRetryablePersistentRestoreConnectFailure(err)
            );
            if (!shouldRetry) {
              throw err;
            }
            this.logger?.warn?.('Retrying persistent voice session restore after transient voice connect failure', {
              guildId,
              channelId: voiceChannelId,
              attempt,
              maxAttempts: PERSISTENT_RESTORE_CONNECT_RETRY_ATTEMPTS,
              error: err instanceof Error ? err.message : String(err),
            });
            await session.connection.disconnect?.().catch(() => null);
            await delay(PERSISTENT_RESTORE_CONNECT_RETRY_DELAY_MS);
          }
        }
        if (lastConnectError) {
          throw lastConnectError;
        }
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




