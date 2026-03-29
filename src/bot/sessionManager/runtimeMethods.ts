import {
  buildSnapshotRestoreQuery,
  cloneTrackForSnapshot,
  createSessionKey,
  hasPendingTracks,
  isSnapshotTrackDirectlyPlayable,
  normalizeSessionChannelId,
  normalizeVoiceProfileSettings,
  toChannelId,
  toSeekStartSec,
  toSnapshotPersistOptions,
} from './runtimeHelpers.ts';
import type { Session, SessionSnapshotDocument, Track, VoiceProfileSettings } from '../../types/domain.ts';
import type { SessionManager } from '../sessionManager.ts';

type RuntimeErrorLike = { status?: unknown; message?: unknown } | null | undefined;
type PersistentVoiceBindingEntry = { voiceChannelId?: string | null; textChannelId?: string | null };
type SnapshotTrackLike = Partial<Track> | null | undefined;
type SnapshotStateLike = {
  volumePercent?: number;
  loopMode?: string;
  paused?: boolean;
  playing?: boolean;
  progressSec?: number;
};

function isStartupPlaybackError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? '').toLowerCase();
  return message.includes('playback pipeline exited before audio output');
}

function sanitizeRestoredTrackData(track: Partial<Track> | null | undefined, seekStartSec: number, requestedBy: string | null) {
  const source = String(track?.source ?? '').trim().toLowerCase();
  const isDeezerTrack = Boolean(track?.deezerTrackId) || source.startsWith('deezer');

  return {
    ...track,
    requestedBy,
    seekStartSec,
    ...(isDeezerTrack ? { deezerFullStreamUrl: null } : {}),
  };
}
type RuntimeMethods = {
  _isPermanentPersistentVoiceFailure(error: RuntimeErrorLike): boolean;
  _resetVoteState(session: Session, trackId?: string | null): void;
  _scheduleIdleTimeout(session: Session): void;
  _isSessionPlaybackActive(session: Session | null | undefined): boolean;
  _hasHumanListeners(session: Session | null | undefined): boolean;
  _countHumanListeners(session: Session | null | undefined): number;
  _startPlaybackDiagnostics(session: Session | null | undefined): void;
  _stopPlaybackDiagnostics(session: Session | null | undefined): void;
  _emitPlaybackDiagnosticsTick(session: Session | null | undefined): Promise<void>;
  _clearIdleTimer(session: Session): void;
  markSnapshotDirty(session: Session | null | undefined, flushSoon?: boolean): void;
  _startSnapshotFlushLoop(): void;
  flushDirtySnapshots(): Promise<void>;
  buildSessionSnapshot(session: Session | null | undefined): SessionSnapshotDocument | null;
  persistSessionSnapshot(session: Session | null | undefined, options?: unknown): Promise<boolean>;
  restoreSessionSnapshot(session: Session | null | undefined): Promise<boolean>;
  _restoreTrackFromSnapshot(session: Session | null | undefined, track: SnapshotTrackLike, options?: unknown): Promise<unknown>;
  adoptVoiceChannel(session: Session, channelId: unknown): Session;
  _hasSessionInstance(session: Session | null | undefined): boolean;
  _loadVoiceProfileSettings(guildId: unknown, voiceChannelId: unknown): Promise<VoiceProfileSettings>;
  _isSessionRestartRecoverable(session: Session | null | undefined): boolean;
  _loadGuildConfig(guildId: string): Promise<unknown>;
  _inspectPersistentVoiceChannel(guildId: string, voiceChannelId: string): Promise<'unknown' | 'missing' | 'present'>;
  _clearPersistentVoiceBinding(guildId: string, voiceChannelId: string): Promise<boolean>;
  _handleQueueEmpty(session: Session, event?: Record<string, unknown>): Promise<void>;
  _isSnapshotTrackDirectlyPlayable(track: unknown): boolean;
};

export const runtimeMethods: RuntimeMethods & ThisType<SessionManager> = {
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
  },

  _resetVoteState(session, trackId = null) {
    if (!session.votes) {
      session.votes = { trackId: null, voters: new Set() };
    }
    session.votes.trackId = trackId;
    session.votes.voters = new Set();
  },

  _scheduleIdleTimeout(session) {
    this._clearIdleTimer(session);

    const idleMs = Number(this.config.sessionIdleMs ?? 0);
    if (idleMs <= 0) return;
    if (session.settings.stayInVoiceEnabled) return;

    session.idleTimer = setTimeout(async () => {
      const guildSessions = this.listByGuild(session.guildId);
      if (!this._hasSessionInstance(session) && guildSessions.length > 0) {
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

      const selector = session.sessionId != null ? { sessionId: session.sessionId } : undefined;
      await this.destroy(session.guildId, 'idle_timeout', selector);
    }, idleMs);
  },

  _isSessionPlaybackActive(session) {
    const player = session?.player ?? null;
    const connection = session?.connection ?? null;

    const isPlayingFlag = Boolean(player?.playing);
    const hasCurrentTrack = Boolean(player?.currentTrack);
    const hasQueuedTracks = Number(player?.queue?.pendingSize ?? 0) > 0;
    const isStreaming = Boolean(connection?.isStreaming);

    return isPlayingFlag || hasCurrentTrack || hasQueuedTracks || isStreaming;
  },

  _hasHumanListeners(session) {
    const store = this.voiceStateStore;
    if (!store || typeof store.countUsersInChannel !== 'function') return false;

    const guildId = String(session?.guildId ?? '').trim();
    const channelId = String(session?.connection?.channelId ?? '').trim();
    if (!guildId || !channelId) return false;

    const listeners = this._countHumanListeners(session);
    return Number.isFinite(listeners) && listeners > 0;
  },

  _countHumanListeners(session) {
    const store = this.voiceStateStore;
    if (!store || typeof store.countUsersInChannel !== 'function') return 0;

    const guildId = String(session?.guildId ?? '').trim();
    const channelId = String(session?.connection?.channelId ?? '').trim();
    if (!guildId || !channelId) return 0;

    const excluded = this.botUserId ? [this.botUserId] : [];
    const listeners = store.countUsersInChannel(guildId, channelId, excluded);
    return Number.isFinite(listeners) ? listeners : 0;
  },

  _startPlaybackDiagnostics(session) {
    if (!this.config.playbackDiagnosticsEnabled) return;
    if (!session || session.diagnostics?.timer) return;

    const diagnostics = session.diagnostics ?? { timer: null, inFlight: false };
    session.diagnostics = diagnostics;

    const intervalMs = Math.max(250, Number.parseInt(String(this.config.playbackDiagnosticsIntervalMs ?? 1000), 10) || 1000);
    diagnostics.timer = setInterval(() => {
      this._emitPlaybackDiagnosticsTick(session).catch(() => null);
    }, intervalMs);
    (diagnostics.timer as NodeJS.Timeout | null)?.unref?.();

    this._emitPlaybackDiagnosticsTick(session).catch(() => null);
  },

  _stopPlaybackDiagnostics(session) {
    const diagnostics = session?.diagnostics;
    if (!diagnostics?.timer) return;

    clearInterval(diagnostics.timer as NodeJS.Timeout);
    diagnostics.timer = null;
    diagnostics.inFlight = false;
  },

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
      const track = (player?.currentTrack as Track | null | undefined) ?? null;
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
  },

  _clearIdleTimer(session) {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer as NodeJS.Timeout);
    session.idleTimer = null;
  },

  markSnapshotDirty(session, flushSoon = false) {
    if (!session?.snapshot) return;
    session.snapshot.dirty = true;
    if (flushSoon) {
      this.persistSessionSnapshot(session, { force: true }).catch(() => null);
    }
  },

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
  },

  async flushDirtySnapshots() {
    for (const session of this.sessions.values()) {
      if (!session?.snapshot) continue;
      const shouldPersistActivePlayback = this._isSessionRestartRecoverable(session);
      if (!session.snapshot.dirty && !shouldPersistActivePlayback) continue;
      await this.persistSessionSnapshot(session).catch(() => null);
    }
  },

  buildSessionSnapshot(session) {
    const player = session?.player ?? null;
    const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
    if (!session?.guildId || !voiceChannelId) return null;
    if (!session?.settings?.stayInVoiceEnabled && !this._isSessionRestartRecoverable(session)) return null;
    const maxPendingTracks = Math.max(
      1,
      Number.parseInt(String(this.config.sessionSnapshotMaxPendingTracks ?? 25), 10) || 25
    );

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
        ? (player.pendingTracks as Track[])
          .slice(0, maxPendingTracks)
          .map((track) => cloneTrackForSnapshot(track, 0))
          .filter((track): track is Track => track !== null)
        : [],
      updatedAt: new Date(),
    };
  },

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

    const persistOptions = toSnapshotPersistOptions(options);
    if (!persistOptions.force && session.snapshot.lastPersistAt > 0 && (Date.now() - session.snapshot.lastPersistAt) < minIntervalMs) {
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
  },

  async restoreSessionSnapshot(session) {
    const voiceChannelId = toChannelId(session?.connection?.channelId) ?? toChannelId(session?.targetVoiceChannelId);
    if (!this.library?.getSessionSnapshot || !session?.guildId || !voiceChannelId) return false;

    const snapshot = await this.library.getSessionSnapshot(session.guildId, voiceChannelId).catch(() => null) as SessionSnapshotDocument | null;
    if (!snapshot) return false;

    const state: SnapshotStateLike = snapshot.state ?? {};
    if (state.volumePercent != null && Number.isFinite(state.volumePercent) && typeof session.player.setVolumePercent === 'function') {
      session.player.setVolumePercent(state.volumePercent);
    }
    if (state.loopMode && typeof session.player.setLoopMode === 'function') {
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

    session.player.clearQueue?.();
    if (currentTrack) {
      let startupPlaybackFailed = false;
      const onTrackError = ({ error }: { error?: unknown } = {}) => {
        if (!isStartupPlaybackError(error)) return;
        startupPlaybackFailed = true;
        session.player.clearQueue?.();
      };
      session.restoreState = {
        inProgress: true,
        suppressStartupErrors: true,
      };
      session.player.on?.('trackError', onTrackError);
      session.player.enqueueResolvedTracks?.([currentTrack, ...pendingTracks], { dedupe: false });
      try {
        await session.player.play?.();
      } finally {
        session.player.off?.('trackError', onTrackError);
        delete session.restoreState;
      }
      if (startupPlaybackFailed) {
        return false;
      }
      if (state.paused) {
        session.player.pause?.();
      }
      this.markSnapshotDirty(session);
      return true;
    }

    if (pendingTracks.length) {
      session.player.enqueueResolvedTracks?.(pendingTracks, { dedupe: false });
      if (state.playing) {
        await session.player.play?.();
        if (state.paused) {
          session.player.pause?.();
        }
      }
      this.markSnapshotDirty(session);
      return true;
    }

    return false;
  },

  async _restoreTrackFromSnapshot(session, track, options = {}) {
    if (!session?.player || !track || typeof track !== 'object') return null;
    if (typeof session.player.createTrackFromData !== 'function') return null;

    const restoreOptions = toSnapshotPersistOptions(options);
    const seekStartSec = toSeekStartSec(restoreOptions.seekStartSec ?? track?.seekStartSec ?? 0);
    const requestedBy = track?.requestedBy ?? null;
    const restoredTrackData = sanitizeRestoredTrackData(track, seekStartSec, requestedBy);

    if (this._isSnapshotTrackDirectlyPlayable(track)) {
      return session.player.createTrackFromData(restoredTrackData);
    }

    const query = buildSnapshotRestoreQuery(track);
    if (!query || typeof session.player.previewTracks !== 'function') {
      return session.player.createTrackFromData(restoredTrackData);
    }

    try {
      const resolved = await session.player.previewTracks(query, {
        requestedBy,
        limit: 1,
      });
      const playable = (Array.isArray(resolved) ? resolved[0] : null) as Partial<Track> | null;
      if (playable) {
        return session.player.createTrackFromData({
          ...playable,
          requestedBy: playable?.requestedBy ?? requestedBy,
          seekStartSec,
        });
      }
    } catch (err: unknown) {
      this.logger?.debug?.('Failed to re-resolve snapshot track, falling back to stored track data', {
        guildId: session?.guildId ?? null,
        title: String(track?.title ?? '').trim() || null,
        source: String(track?.source ?? '').trim() || null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return session.player.createTrackFromData(restoredTrackData);
  },

  adoptVoiceChannel(session, channelId) {
    const voiceChannelId = normalizeSessionChannelId(channelId);
    if (!session || !voiceChannelId) return session;

    const nextSessionId = createSessionKey(session.guildId, voiceChannelId);
    session.targetVoiceChannelId = voiceChannelId;
    if (session.sessionId === nextSessionId) return session;

    this.sessions.delete(session.sessionId!);
    session.sessionId = nextSessionId;
    this.sessions.set(session.sessionId, session);
    return session;
  },

  _hasSessionInstance(session) {
    if (!session) return false;
    if (session.sessionId && this.sessions.get(session.sessionId) === session) return true;
    return [...this.sessions.values()].includes(session);
  },

  async _loadVoiceProfileSettings(guildId: unknown, voiceChannelId: unknown) {
    const normalizedGuildId = String(guildId ?? '').trim();
    const normalizedVoiceChannelId = normalizeSessionChannelId(voiceChannelId);
    if (!normalizedGuildId || !normalizedVoiceChannelId || !this.library?.getVoiceProfile) {
      return normalizeVoiceProfileSettings(null);
    }

    const profile = await this.library.getVoiceProfile(normalizedGuildId, normalizedVoiceChannelId).catch(() => null);
    return normalizeVoiceProfileSettings(profile);
  },

  _isSessionRestartRecoverable(session) {
    const player = session?.player ?? null;
    return Boolean(
      player?.playing
      || player?.currentTrack
      || hasPendingTracks(player)
    );
  },

  async _loadGuildConfig(guildId) {
    if (!this.guildConfigs) return null;

    try {
      return await this.guildConfigs.get(guildId);
    } catch (err: unknown) {
      this.logger?.warn?.('Failed to load guild config for session bootstrap', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  async _inspectPersistentVoiceChannel(guildId: string, voiceChannelId: string) {
    if (!this.rest?.getChannel) return 'unknown';

    try {
      const channel = await this.rest.getChannel(voiceChannelId) as { guild_id?: string; guildId?: string } | null;
      const channelGuildId = String(channel?.guild_id ?? channel?.guildId ?? '').trim();
      if (channelGuildId && channelGuildId !== String(guildId)) {
        return 'missing';
      }
      return channel ? 'present' : 'unknown';
    } catch (err: unknown) {
      const errorLike = err as { status?: unknown; message?: unknown };
      const status = Number(errorLike.status ?? 0);
      const message = String(errorLike.message ?? '').toLowerCase();
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
  },

  async _clearPersistentVoiceBinding(guildId, voiceChannelId) {
    if (!this.library?.getGuildFeatureConfig || !this.library?.patchGuildFeatureConfig) {
      return false;
    }

    const config = await this.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!config) return false;

    const bindings = Array.isArray(config.persistentVoiceConnections)
      ? config.persistentVoiceConnections
      : [];
    const nextBindings = bindings.filter((entry: PersistentVoiceBindingEntry) => String(entry?.voiceChannelId ?? '').trim() !== String(voiceChannelId));
    const recoveryBindings = Array.isArray(config.restartRecoveryConnections)
      ? config.restartRecoveryConnections
      : [];
    const nextRecoveryBindings = recoveryBindings.filter((entry: PersistentVoiceBindingEntry) => (
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
  },

  async _handleQueueEmpty(session, event = {}) {
    this.emit('queueEmpty', { session, ...event });

    if (session.settings.stayInVoiceEnabled) {
      session.idleTimeoutIgnoreListeners = false;
      this._clearIdleTimer(session);
      return;
    }

    session.idleTimeoutIgnoreListeners = true;
    this._scheduleIdleTimeout(session);
  },

  _isSnapshotTrackDirectlyPlayable(track: unknown) {
    return isSnapshotTrackDirectlyPlayable(track as Partial<Track> | null | undefined);
  },
};
