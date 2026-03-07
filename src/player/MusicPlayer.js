import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { sourceMethods } from './musicPlayer/sourceMethods.js';
import { AudiusClient } from './musicPlayer/AudiusClient.js';
import { DeezerClient } from './musicPlayer/DeezerClient.js';
import { ResolverClient } from './musicPlayer/ResolverClient.js';
import { SoundCloudClient } from './musicPlayer/SoundCloudClient.js';
import { SpotifyClient } from './musicPlayer/SpotifyClient.js';
import ffmpegPath from 'ffmpeg-static';
import playdl from 'play-dl';
import { Queue } from './Queue.js';
import { LiveAudioProcessor, isLiveFilterPresetSupported } from './LiveAudioProcessor.js';
import { ValidationError } from '../core/errors.js';
import {
  EQ_PRESETS,
  FILTER_PRESETS,
  LOOP_MODES,
  LOOP_OFF,
  LOOP_QUEUE,
  LOOP_TRACK,
} from './musicPlayer/constants.js';
import {
  buildDeezerLegacyDownloadUrl,
  DeezerBfStripeDecryptTransform,
  DEEZER_MEDIA_QUALITY_MAP,
  DEEZER_SESSION_TOKEN_TTL_MS,
  DEEZER_STREAM_BASE_BACKOFF_MS,
  DEEZER_STREAM_HIGH_WATER_MARK,
  DEEZER_STREAM_MAX_BACKOFF_MS,
  DEEZER_STREAM_RETRY_LIMIT,
  isRetryableDeezerStreamError,
  parseContentRangeStart,
} from './musicPlayer/deezer.js';
import {
  isPlayDlBrowseFailure,
  isRetryableYtDlpStartupError,
  isSoundCloudAuthorizationError,
  normalizeDeezerTrackFormats,
  normalizeYouTubePlaylistResolver,
  normalizeYtDlpArgs,
  parseCsvArgs,
  soundCloudAuthorizationHelp,
} from './musicPlayer/errorUtils.js';
import {
  buildTrackId,
  buildYouTubeThumbnailFromUrl,
  clamp,
  extractDeezerTrackId,
  getYouTubePlaylistId,
  inferYouTubeWatchUrlFromPlaylist,
  isAudiusUrl,
  isDeezerUrl,
  isHttpUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isYouTubeUrl,
  normalizeThumbnailUrl,
  normalizeYouTubeVideoUrlFromEntry,
  pickArtistName,
  pickThumbnailUrlFromItem,
  pickTrackArtistFromMetadata,
  sanitizeUrlToSearchQuery,
  toAudiusDurationLabel,
  toCanonicalYouTubePlaylistUrl,
  toCanonicalYouTubeWatchUrl,
  toDeezerDurationLabel,
  toDurationLabel,
  toSoundCloudDurationLabel,
} from './musicPlayer/trackUtils.js';
import {
  bindPipelineErrorHandler,
  cleanupProcesses,
  clearPipelineErrorHandlers,
  clearPipelineState,
  isExpectedPipeError,
  normalizePlaybackError,
  resetPlaybackClock,
  startPlaybackClock,
  stopVoiceStream,
} from './musicPlayer/processUtils.js';

export class MusicPlayer extends EventEmitter {
  constructor(voice, options = {}) {
    super();
    this.voice = voice;
    this.queue = new Queue();
    this.logger = options.logger;

    this.ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || ffmpegPath || 'ffmpeg';
    this.ytdlpBin = options.ytdlpBin || process.env.YTDLP_BIN || null;
    this.ytdlpCookiesFile = options.ytdlpCookiesFile || process.env.YTDLP_COOKIES_FILE || null;
    this.ytdlpCookiesFromBrowser = options.ytdlpCookiesFromBrowser || process.env.YTDLP_COOKIES_FROM_BROWSER || null;
    const configuredYtdlpClient = options.ytdlpYoutubeClient ?? process.env.YTDLP_YOUTUBE_CLIENT ?? null;
    this.ytdlpYoutubeClient = String(configuredYtdlpClient ?? '').trim() || null;
    const configuredYtDlpExtraArgs = options.ytdlpExtraArgs ?? process.env.YTDLP_EXTRA_ARGS ?? null;
    const rawYtDlpExtraArgs = Array.isArray(configuredYtDlpExtraArgs)
      ? configuredYtDlpExtraArgs
      : parseCsvArgs(configuredYtDlpExtraArgs);
    this.ytdlpExtraArgs = normalizeYtDlpArgs(rawYtDlpExtraArgs);
    this._useRuntimeYtDlpCookiesFile();

    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.maxPlaylistTracks = options.maxPlaylistTracks ?? 25;
    this.minVolumePercent = options.minVolumePercent ?? 0;
    this.maxVolumePercent = options.maxVolumePercent ?? 200;
    this.enableYtSearch = options.enableYtSearch !== false;
    this.enableYtPlayback = options.enableYtPlayback !== false;
    this.enableSpotifyImport = options.enableSpotifyImport !== false;
    this.enableDeezerImport = options.enableDeezerImport !== false;
    this.spotifyClientId = String(options.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? '').trim() || null;
    this.spotifyClientSecret = String(options.spotifyClientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? '').trim() || null;
    this.spotifyRefreshToken = String(options.spotifyRefreshToken ?? process.env.SPOTIFY_REFRESH_TOKEN ?? '').trim() || null;
    this.spotifyMarket = String(options.spotifyMarket ?? process.env.SPOTIFY_MARKET ?? 'US').trim().toUpperCase() || 'US';
    this.deezerArl = String(options.deezerArl ?? process.env.DEEZER_ARL ?? '').trim() || null;
    this.deezerTrackFormats = normalizeDeezerTrackFormats(
      options.deezerTrackFormats ?? process.env.DEEZER_TRACK_FORMATS ?? null
    );
    this._deezerCookieHeader = this.deezerArl ? `arl=${this.deezerArl}` : null;
    this._deezerSessionTokens = null;
    this._spotifyAccessToken = null;
    this._spotifyAccessTokenExpiresAtMs = 0;
    this.soundcloudClientId = String(options.soundcloudClientId ?? process.env.SOUNDCLOUD_CLIENT_ID ?? '').trim() || null;
    this.soundcloudAutoClientId = options.soundcloudAutoClientId !== false;
    this.youtubePlaylistResolver = normalizeYouTubePlaylistResolver(
      options.youtubePlaylistResolver ?? process.env.YOUTUBE_PLAYLIST_RESOLVER
    );

    this.filterPreset = 'off';
    this.eqPreset = 'flat';
    this.tempoRatio = 1.0;
    this.pitchSemitones = 0;

    this.volumePercent = options.defaultVolumePercent ?? 100;
    this.loopMode = LOOP_OFF;

    this.ffmpeg = null;
    this.sourceProc = null;
    this.sourceStream = null;
    this.deezerDecryptStream = null;
    this.liveAudioProcessor = null;
    this._deezerStreamMetaByTrackId = new Map();
    this.pipelineErrorHandlers = [];
    this.sources = Object.freeze({
      audius: new AudiusClient(this),
      deezer: new DeezerClient(this),
      spotify: new SpotifyClient(this),
      resolver: new ResolverClient(this),
      soundcloud: new SoundCloudClient(this),
    });

    this.playing = false;
    this.paused = false;
    this.skipRequested = false;

    this.pendingSeekTrack = null;
    this.trackHistory = [];
    this.maxHistorySize = options.maxHistorySize ?? 100;
    this.trackStartedAtMs = null;
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
    this.currentTrackOffsetSec = 0;
    this.lastKnownTrack = null;
    this.lastKnownTrackAtMs = 0;
    this.activePlaybackToken = 0;
    this.soundcloudClientIdResolvedAt = this.soundcloudClientId ? Date.now() : 0;

    this._lastYtDlpDiagnostics = null;
    this._lastFfmpegArgs = null;
  }

  _useRuntimeYtDlpCookiesFile() {
    if (!this.ytdlpCookiesFile || this.ytdlpCookiesFromBrowser) return;

    const sourcePath = String(this.ytdlpCookiesFile).trim();
    if (!sourcePath) return;

    if (!existsSync(sourcePath)) {
      this.logger?.warn?.('Configured yt-dlp cookies file not found', {
        path: sourcePath,
      });
      return;
    }

    const runtimePath = join(
      tmpdir(),
      `${basename(sourcePath)}.runtime-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    );
    try {
      copyFileSync(sourcePath, runtimePath);
      this.ytdlpCookiesFile = runtimePath;
      this.logger?.info?.('Using runtime copy of yt-dlp cookies file to avoid mutating source cookies', {
        sourcePath,
        runtimePath,
      });
    } catch (err) {
      this.logger?.warn?.('Failed to prepare runtime yt-dlp cookies file copy, using source file directly', {
        sourcePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get currentTrack() {
    return this.queue.current;
  }

  get displayTrack() {
    if (this.currentTrack) return this.currentTrack;
    const recentEnough = this.lastKnownTrackAtMs > 0 && (Date.now() - this.lastKnownTrackAtMs) <= 30_000;
    if (this.voice?.isStreaming && this.lastKnownTrack && recentEnough) {
      return this.lastKnownTrack;
    }
    return null;
  }

  get pendingTracks() {
    return [...this.queue.tracks];
  }

  get historyTracks() {
    return [...this.trackHistory];
  }

  getState() {
    return {
      playing: this.playing,
      paused: this.paused,
      loopMode: this.loopMode,
      volumePercent: this.volumePercent,
      current: this.currentTrack,
      pendingCount: this.queue.pendingSize,
      progressSec: this.getProgressSeconds(),
      historyCount: this.trackHistory.length,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  }

  getProgressSeconds() {
    if (!this.currentTrack) return 0;

    if (!this.playing || !this.trackStartedAtMs) {
      return Math.max(0, this.currentTrackOffsetSec);
    }

    const now = this.paused && this.pauseStartedAtMs ? this.pauseStartedAtMs : Date.now();
    const elapsedMs = Math.max(0, now - this.trackStartedAtMs - this.totalPausedMs);
    return Math.max(0, this.currentTrackOffsetSec + Math.floor(elapsedMs / 1000));
  }

  setLoopMode(mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!LOOP_MODES.has(normalized)) {
      throw new ValidationError(`Invalid loop mode: ${mode}`);
    }

    this.loopMode = normalized;
    return this.loopMode;
  }

  setVolumePercent(value) {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next)) {
      throw new ValidationError('Volume must be a number.');
    }
    if (next < this.minVolumePercent || next > this.maxVolumePercent) {
      throw new ValidationError(`Volume must be between ${this.minVolumePercent} and ${this.maxVolumePercent}.`);
    }

    this.volumePercent = next;
    this._syncLiveAudioProcessor();
    return this.volumePercent;
  }

  setFilterPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase() || 'off';
    if (!FILTER_PRESETS[normalized]) {
      throw new ValidationError(`Unknown filter preset: ${name}`);
    }

    this.filterPreset = normalized;
    this._syncLiveAudioProcessor();
    return this.filterPreset;
  }

  setEqPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!EQ_PRESETS[normalized]) {
      throw new ValidationError(`Unknown EQ preset: ${name}`);
    }

    this.eqPreset = normalized;
    this._syncLiveAudioProcessor();
    return this.eqPreset;
  }

  setTempoRatio(value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2.0) {
      throw new ValidationError('Tempo must be between 0.5 and 2.0.');
    }

    this.tempoRatio = parsed;
    return this.tempoRatio;
  }

  setPitchSemitones(value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < -12 || parsed > 12) {
      throw new ValidationError('Pitch must be between -12 and +12 semitones.');
    }

    this.pitchSemitones = parsed;
    return this.pitchSemitones;
  }

  getAudioEffectsState() {
    return {
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  }

  getAvailableFilterPresets() {
    return Object.keys(FILTER_PRESETS)
      .filter((name) => name !== 'karoake')
      .sort();
  }

  getAvailableEqPresets() {
    return Object.keys(EQ_PRESETS).sort();
  }

  clearQueue() {
    this.queue.tracks = [];
    return 0;
  }

  shuffleQueue() {
    this.queue.shuffle();
    return this.queue.pendingSize;
  }

  removeFromQueue(index) {
    return this.queue.remove(index);
  }

  getLastHistoryTrack() {
    if (!this.trackHistory.length) return null;
    return this.trackHistory[this.trackHistory.length - 1];
  }

  replayCurrentTrack() {
    if (!this.currentTrack || !this.playing) return false;
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  }

  refreshCurrentTrackProcessing() {
    if (!this.playing || !this.currentTrack) return false;

    // Mid-track seek restarts are significantly more likely to trigger YouTube challenge failures.
    // For effect reprocessing, prefer a clean restart from 0 for stability.
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  }

  getTotalPendingDurationSeconds() {
    let total = 0;
    for (const track of this.pendingTracks) {
      const parsed = this._parseDurationSeconds(track.duration);
      if (parsed == null) continue;
      total += parsed;
    }
    return total;
  }

  queuePreviousTrack() {
    const previous = this.getLastHistoryTrack();
    if (!previous) return null;

    const clone = this._cloneTrack(previous);
    this.queue.addFront(clone);
    this.emit('tracksAdded', [clone]);
    return clone;
  }

  canSeekCurrentTrack() {
    if (!this.currentTrack) return false;
    return isYouTubeUrl(this.currentTrack.url);
  }

  seekTo(seconds) {
    if (!this.playing || !this.currentTrack) {
      throw new ValidationError('Nothing is currently playing.');
    }

    if (!this.canSeekCurrentTrack()) {
      throw new ValidationError('Seek is currently supported for YouTube tracks only.');
    }

    const target = Number.parseInt(String(seconds), 10);
    if (!Number.isFinite(target) || target < 0) {
      throw new ValidationError('Seek target must be a non-negative number of seconds.');
    }

    this.pendingSeekTrack = {
      ...this.currentTrack,
      seekStartSec: target,
    };

    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return target;
  }

  async enqueue(query, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const playNext = Boolean(options.playNext);
    const dedupe = Boolean(options.dedupe);

    const tracks = await this._resolveTracks(query, requestedBy);
    if (!tracks.length) return [];

    return this.enqueueResolvedTracks(tracks, { dedupe, playNext });
  }

  enqueueResolvedTracks(tracks, options = {}) {
    const playNext = Boolean(options.playNext);
    const dedupe = Boolean(options.dedupe);
    const queueGuard = options.queueGuard && typeof options.queueGuard === 'object'
      ? options.queueGuard
      : null;
    const input = Array.isArray(tracks) ? tracks : [];
    if (!input.length) return [];

    const filteredTracks = dedupe
      ? input.filter((track) => !this._hasDuplicateTrack(track))
      : input;

    if (!filteredTracks.length) {
      return [];
    }

    if (queueGuard?.enabled) {
      this._enforceQueueGuard(filteredTracks, queueGuard);
    }

    if (this.queue.pendingSize + filteredTracks.length > this.maxQueueSize) {
      throw new ValidationError(`Queue limit exceeded (${this.maxQueueSize} pending tracks max).`);
    }

    if (playNext) {
      for (let i = filteredTracks.length - 1; i >= 0; i -= 1) {
        this.queue.addFront(filteredTracks[i]);
      }
    } else {
      for (const track of filteredTracks) {
        this.queue.add(track);
      }
    }

    this.emit('tracksAdded', filteredTracks);
    return filteredTracks;
  }

  _enforceQueueGuard(newTracks, guard) {
    const pending = this.pendingTracks;
    const windowSize = Math.max(1, Math.min(200, Number.parseInt(String(guard.windowSize ?? 25), 10) || 25));
    const maxPerRequesterWindow = Math.max(1, Math.min(50, Number.parseInt(String(guard.maxPerRequesterWindow ?? 5), 10) || 5));
    const maxArtistStreak = Math.max(1, Math.min(20, Number.parseInt(String(guard.maxArtistStreak ?? 3), 10) || 3));

    const queueWindow = pending.slice(-windowSize);
    const requesterCounts = new Map();
    for (const track of queueWindow) {
      const requester = String(track?.requestedBy ?? '').trim();
      if (!requester) continue;
      requesterCounts.set(requester, (requesterCounts.get(requester) ?? 0) + 1);
    }

    for (const track of newTracks) {
      const requester = String(track?.requestedBy ?? '').trim();
      if (!requester) continue;
      const nextCount = (requesterCounts.get(requester) ?? 0) + 1;
      if (nextCount > maxPerRequesterWindow) {
        throw new ValidationError(
          `Queue guard: requester limit reached (${maxPerRequesterWindow} tracks per ${windowSize} queue items).`
        );
      }
      requesterCounts.set(requester, nextCount);
    }

    const artistQueue = [...pending, ...newTracks].map((track) => this._trackArtistKey(track)).filter(Boolean);
    let streak = 1;
    for (let i = 1; i < artistQueue.length; i += 1) {
      if (artistQueue[i] === artistQueue[i - 1]) {
        streak += 1;
      } else {
        streak = 1;
      }
      if (streak > maxArtistStreak) {
        throw new ValidationError(
          `Queue guard: max artist streak exceeded (${maxArtistStreak}). Mix in a different artist.`
        );
      }
    }
  }

  _trackArtistKey(track) {
    const explicit = String(track?.artist ?? '').trim().toLowerCase();
    if (explicit) return explicit;

    const title = String(track?.title ?? '').trim().toLowerCase();
    if (!title) return null;
    if (title.includes(' - ')) {
      return title.split(' - ')[0].trim();
    }
    return title.split(' ').slice(0, 2).join(' ').trim();
  }

  async play() {
    if (this.playing) return;

    const track = this.queue.next();
    if (!track) {
      this._stopVoiceStream();
      this.emit('queueEmpty');
      return;
    }
    const playbackToken = ++this.activePlaybackToken;

    this.playing = true;
    this.paused = false;
    this.skipRequested = false;

    try {
      this._clearPipelineState();

      if (isYouTubeUrl(track.url)) {
        await this._startYouTubePipeline(track.url, track.seekStartSec ?? 0);
      } else if (String(track.source ?? '').startsWith('audius')) {
        await this.sources.audius.startPipeline(track, track.seekStartSec ?? 0);
      } else if (track?.deezerTrackId || String(track.source ?? '').startsWith('deezer-direct')) {
        await this.sources.deezer.startPipeline(track, track.seekStartSec ?? 0);
      } else if (String(track.source ?? '').startsWith('soundcloud')) {
        await this.sources.soundcloud.startPipeline(track, track.seekStartSec ?? 0);
      } else {
        await this._startPlayDlPipeline(track.url, 0);
      }

      let playbackStarted = false;
      this.ffmpeg.once('close', async (code, signal) => {
        if (!playbackStarted) return;
        await this._handleTrackClose(track, code, signal, playbackToken);
      });

      this.liveAudioProcessor = this._createLiveAudioProcessor();
      this._bindPipelineErrorHandler(this.liveAudioProcessor, 'liveAudioProcessor');
      this.ffmpeg.stdout.pipe(this.liveAudioProcessor);
      await this.voice.sendAudio(this.liveAudioProcessor);
      await this._awaitInitialPlaybackChunk(
        this.liveAudioProcessor,
        this.ffmpeg,
        this._getInitialPlaybackChunkTimeoutMs(track)
      );
      playbackStarted = true;
      this._startPlaybackClock(track.seekStartSec ?? 0);
      this.lastKnownTrack = track;
      this.lastKnownTrackAtMs = Date.now();
      this.emit('trackStart', track);
      this.logger?.info?.('Playback started', { title: track.title, url: track.url, seek: track.seekStartSec ?? 0 });
    } catch (err) {
      const normalized = this._normalizePlaybackError(err);
      this.emit('trackError', { track, error: normalized });
      this.logger?.error?.('Playback setup failed', { track: track.title, error: normalized.message });

      this._cleanupProcesses();
      this.playing = false;
      this.paused = false;
      this._resetPlaybackClock();
      this.queue.current = null;

      if (this.queue.pendingSize > 0) {
        await this.play();
        return;
      }

      this._stopVoiceStream();
      this.emit('queueEmpty', { reason: 'startup_error' });
    }
  }

  pause() {
    if (!this.playing || this.paused) return false;
    if (!this._setPipelinePaused(true)) return false;

    this.paused = true;
    this.pauseStartedAtMs = Date.now();
    return true;
  }

  resume() {
    if (!this.playing || !this.paused) return false;
    if (!this._setPipelinePaused(false)) return false;

    if (this.pauseStartedAtMs) {
      this.totalPausedMs += Date.now() - this.pauseStartedAtMs;
    }

    this.pauseStartedAtMs = null;
    this.paused = false;
    return true;
  }

  _setPipelinePaused(paused) {
    const shouldPause = Boolean(paused);
    const signal = shouldPause ? 'SIGSTOP' : 'SIGCONT';
    const streamMethod = shouldPause ? 'pause' : 'resume';
    const voiceMethod = shouldPause ? 'pauseAudio' : 'resumeAudio';
    let changed = false;

    const applyVoicePause = this.voice?.[voiceMethod];
    if (typeof applyVoicePause === 'function') {
      try {
        changed = Boolean(applyVoicePause.call(this.voice)) || changed;
      } catch {
        // ignore voice pause/resume errors
      }
    }

    if (process.platform !== 'win32') {
      for (const proc of [this.sourceProc, this.ffmpeg]) {
        if (!proc?.kill) continue;
        try {
          proc.kill(signal);
          changed = true;
        } catch (err) {
          this.logger?.debug?.('Process signal pause/resume failed; falling back to stream controls', {
            signal,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const stream of [this.sourceStream, this.sourceProc?.stdout, this.ffmpeg?.stdout]) {
      const method = stream?.[streamMethod];
      if (typeof method !== 'function') continue;
      try {
        method.call(stream);
        changed = true;
      } catch {
        // ignore stream pause/resume errors
      }
    }

    return changed;
  }

  skip() {
    if (!this.playing) return false;
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  }

  stop() {
    this.skipRequested = true;
    this.pendingSeekTrack = null;
    this.queue.clear();
    this._cleanupProcesses();
    this._stopVoiceStream();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();
  }

  async _handleTrackClose(track, code, signal, playbackToken = null) {
    if (playbackToken != null && playbackToken !== this.activePlaybackToken) {
      this.logger?.debug?.('Ignoring stale track close event', {
        title: track?.title ?? null,
        token: playbackToken,
        activeToken: this.activePlaybackToken,
      });
      return;
    }

    const wasSkip = this.skipRequested;
    const pendingSeekTrack = this.pendingSeekTrack;
    this.pendingSeekTrack = null;

    this._cleanupProcesses();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();

    this.queue.current = null;

    this.emit('trackEnd', {
      track,
      code,
      signal,
      skipped: wasSkip,
      seekRestart: Boolean(pendingSeekTrack),
    });

    if (!pendingSeekTrack) {
      this._rememberTrack(track);
    }

    if (pendingSeekTrack) {
      this.queue.addFront(pendingSeekTrack);
      await this.play();
      return;
    }

    if (!wasSkip) {
      if (this.loopMode === LOOP_TRACK) {
        this.queue.addFront(this._cloneTrack(track, { seekStartSec: 0 }));
      } else if (this.loopMode === LOOP_QUEUE) {
        this.queue.add(this._cloneTrack(track, { seekStartSec: 0 }));
      }
    }

    if (this.queue.pendingSize > 0) {
      await this.play();
      return;
    }

    this._stopVoiceStream();
    this.emit('queueEmpty');
  }

  async _resolveTracks(query, requestedBy) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      throw new ValidationError('Missing query.');
    }

    if (!isHttpUrl(raw)) {
      return this._resolveSearchTrack(raw, requestedBy);
    }

    const url = await this.sources.resolver.normalizeInputUrl(raw);
    const validation = await playdl.validate(url).catch(() => false);
    const playlistUrl = toCanonicalYouTubePlaylistUrl(url);
    const effectiveValidation = (
      playlistUrl
        ? 'yt_playlist'
        : validation
    );

    switch (effectiveValidation) {
      case 'yt_video':
        return this._resolveSingleYouTubeTrack(url, requestedBy);
      case 'yt_playlist':
        return this._resolveYouTubePlaylistTracks(playlistUrl ?? url, requestedBy, {
          fallbackWatchUrl: toCanonicalYouTubeWatchUrl(url) ?? inferYouTubeWatchUrlFromPlaylist(url),
        });
      case 'so_track':
        return this.sources.soundcloud.resolveTrack(url, requestedBy);
      case 'so_playlist':
        return this.sources.soundcloud.resolvePlaylist(url, requestedBy);
      case 'sp_track':
        return this.sources.resolver.resolveSpotifyTrack(url, requestedBy);
      case 'sp_playlist':
      case 'sp_album':
        return this.sources.resolver.resolveSpotifyCollection(url, requestedBy);
      case 'dz_track':
        return this.sources.deezer.resolveTrack(url, requestedBy);
      case 'dz_playlist':
      case 'dz_album':
        return this.sources.deezer.resolveCollection(url, requestedBy);
      default:
        if (isAudiusUrl(url)) {
          return this.sources.audius.resolveByUrl(url, requestedBy);
        }
        if (isSoundCloudUrl(url)) {
          return this.sources.soundcloud.resolveByGuess(url, requestedBy);
        }
        if (isDeezerUrl(url)) {
          return this.sources.deezer.resolveByGuess(url, requestedBy);
        }
        if (isSpotifyUrl(url)) {
          return this.sources.resolver.resolveSpotifyByGuess(url, requestedBy);
        }

        return this.sources.resolver.resolveSingleUrlTrack(url, requestedBy);
    }
  }

  async _resolveSearchTrack(query, requestedBy) {
    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this.sources.deezer.searchTracks(query, 1, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const youtube = await this._searchYouTubeTracks(query, 1, requestedBy).catch(() => []);
    if (youtube.length) return youtube;

    return [];
  }

  getDiagnostics() {
    return {
      playing: this.playing,
      paused: this.paused,
      skipRequested: this.skipRequested,
      loopMode: this.loopMode,
      progressSec: this.getProgressSeconds(),
      volumePercent: this.volumePercent,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
      deezerTrackFormats: [...this.deezerTrackFormats],
      pendingCount: this.queue.pendingSize,
      hasCurrentTrack: Boolean(this.currentTrack),
      sourceProcPid: this.sourceProc?.pid ?? null,
      ffmpegPid: this.ffmpeg?.pid ?? null,
      ffmpegArgs: Array.isArray(this._lastFfmpegArgs) ? [...this._lastFfmpegArgs] : null,
      ytdlp: this._lastYtDlpDiagnostics ? { ...this._lastYtDlpDiagnostics } : null,
    };
  }

  async searchCandidates(query, limit = 5, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));

    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this.sources.deezer.searchTracks(query, safeLimit, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const youtube = await this._searchYouTubeTracks(query, safeLimit, requestedBy).catch(() => []);
    if (youtube.length) return youtube;

    return [];
  }

  async _searchYouTubeTracks(query, limit, requestedBy) {
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit }).catch(async (err) => {
      if (!isPlayDlBrowseFailure(err)) throw err;
      this.logger?.warn?.('play-dl searchCandidates failed, trying yt-dlp search fallback', {
        query,
        limit,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._searchWithYtDlp(query, limit);
    });

    return results.map((item) => this._buildTrack({
      title: item.title,
      url: item.url,
      duration: item.durationRaw ?? item.duration,
      thumbnailUrl: pickThumbnailUrlFromItem(item),
      requestedBy,
      source: 'youtube-search',
      artist: pickTrackArtistFromMetadata(item),
    }));
  }

  async _searchDeezerTracks(query, limit, requestedBy) {
    const safeQuery = String(query ?? '').trim();
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    if (!safeQuery || !this.deezerArl || !this.enableDeezerImport) return [];

    const payload = await this._deezerApiRequest(`/search/track?q=${encodeURIComponent(safeQuery)}`).catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const tracks = [];
    for (const item of items) {
      if (tracks.length >= safeLimit) break;
      const track = this._buildDeezerTrackFromMetadata(item, requestedBy, 'deezer-search-direct');
      if (track?.deezerTrackId) {
        tracks.push(track);
      }
    }

    return tracks;
  }

  async previewTracks(query, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const tracks = await this._resolveTracks(query, requestedBy);
    const limit = Number.parseInt(String(options.limit ?? 0), 10);
    if (Number.isFinite(limit) && limit > 0) {
      return tracks.slice(0, limit);
    }
    return tracks;
  }

  createTrackFromData(data, requestedBy = null) {
    const normalizedThumbnailUrl = (
      data?.thumbnailUrl
      ?? data?.thumbnail_url
      ?? data?.thumbnail
      ?? pickThumbnailUrlFromItem(data)
    );

    return this._buildTrack({
      title: data?.title,
      url: data?.url,
      duration: data?.duration,
      thumbnailUrl: normalizedThumbnailUrl,
      requestedBy,
      source: data?.source ?? 'stored',
      artist: data?.artist ?? data?.artist_name ?? pickTrackArtistFromMetadata(data),
      soundcloudTrackId: data?.soundcloudTrackId ?? data?.soundcloud_track_id ?? null,
      audiusTrackId: data?.audiusTrackId ?? data?.audius_track_id ?? null,
      deezerTrackId: data?.deezerTrackId ?? data?.deezer_track_id ?? null,
      deezerPreviewUrl: data?.deezerPreviewUrl ?? data?.deezer_preview_url ?? null,
      deezerFullStreamUrl: data?.deezerFullStreamUrl ?? data?.deezer_full_stream_url ?? null,
      spotifyTrackId: data?.spotifyTrackId ?? data?.spotify_track_id ?? null,
      spotifyPreviewUrl: data?.spotifyPreviewUrl ?? data?.spotify_preview_url ?? null,
      isPreview: data?.isPreview ?? data?.is_preview ?? false,
    });
  }

  async _resolveSingleYouTubeTrack(url, requestedBy) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    try {
      const info = await this._fetchSingleYouTubeTrackViaPlayDl(url);
      return [this._buildTrack({
        title: info.video_details.title,
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'youtube',
        artist: pickTrackArtistFromMetadata(info.video_details),
      })];
    } catch (err) {
      this.logger?.warn?.('play-dl single YouTube metadata lookup failed, trying yt-dlp fallback', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });

      const fallback = await this._resolveSingleYouTubeTrackViaYtDlp(url, requestedBy).catch((fallbackErr) => {
        this.logger?.warn?.('yt-dlp single YouTube metadata fallback failed', {
          url,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        return null;
      });
      if (fallback) return [fallback];

      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'youtube',
      })];
    }
  }

  async _fetchSingleYouTubeTrackViaPlayDl(url) {
    return playdl.video_info(url);
  }

  async _resolveSingleYouTubeTrackViaYtDlp(url, requestedBy) {
    const args = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
    ];

    if (this.ytdlpYoutubeClient) {
      args.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      args.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }

    args.push(url);
    const { stdout } = await this._runYtDlpCommand(args, 15_000);
    if (!stdout?.trim()) {
      throw new Error('yt-dlp returned empty metadata payload.');
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('yt-dlp returned invalid JSON metadata.');
    }

    const resolvedUrl = (
      String(payload?.webpage_url ?? '').trim()
      || toCanonicalYouTubeWatchUrl(url)
      || url
    );
    const title = String(payload?.title ?? '').trim() || resolvedUrl;

    return this._buildTrack({
      title,
      url: resolvedUrl,
      duration: payload?.duration_string ?? payload?.duration ?? 'Unknown',
      thumbnailUrl: pickThumbnailUrlFromItem(payload),
      requestedBy,
      source: 'youtube',
      artist: pickTrackArtistFromMetadata(payload) || String(payload?.channel ?? payload?.uploader ?? '').trim() || null,
    });
  }

  async _resolveYouTubePlaylistTracks(url, requestedBy, options = {}) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const order = this.youtubePlaylistResolver === 'playdl'
      ? ['playdl', 'ytdlp']
      : ['ytdlp', 'playdl'];

    const resolverErrors = [];
    for (const resolver of order) {
      if (resolver === 'ytdlp') {
        try {
          const tracks = await this._resolveYouTubePlaylistTracksViaYtDlp(url, requestedBy);
          if (tracks.length) {
            this.logger?.info?.('Resolved YouTube playlist via yt-dlp', {
              url,
              count: tracks.length,
              mode: this.youtubePlaylistResolver,
            });
            return tracks;
          }
          throw new Error('yt-dlp returned no playlist entries');
        } catch (err) {
          resolverErrors.push({ resolver, error: err });
          this.logger?.warn?.('yt-dlp playlist lookup failed', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      try {
        const tracks = await this._resolveYouTubePlaylistTracksViaPlayDl(url, requestedBy);
        if (tracks.length) {
          if (this.youtubePlaylistResolver !== 'playdl') {
            this.logger?.info?.('Resolved YouTube playlist via play-dl fallback', {
              url,
              count: tracks.length,
            });
          }
          return tracks;
        }
        throw new Error('play-dl returned no playlist entries');
      } catch (err) {
        resolverErrors.push({ resolver, error: err });
        this.logger?.warn?.('play-dl playlist lookup failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const watchUrl = options.fallbackWatchUrl ?? inferYouTubeWatchUrlFromPlaylist(url) ?? toCanonicalYouTubeWatchUrl(url);
    if (watchUrl) {
      return this._resolveSingleYouTubeTrack(watchUrl, requestedBy);
    }

    if (resolverErrors.length > 0) {
      const summary = resolverErrors
        .map(({ resolver, error }) => `${resolver}:${error instanceof Error ? error.message : String(error)}`)
        .join(' | ')
        .slice(0, 900);
      this.logger?.warn?.('All YouTube playlist resolvers failed, using search fallback', {
        url,
        errors: summary,
      });
    }

    return this._resolveFromUrlFallbackSearch(url, requestedBy, 'youtube-playlist-fallback');
  }

  async _fetchYouTubePlaylistInfo(url) {
    return playdl.playlist_info(url, { incomplete: true });
  }

  async _resolveYouTubePlaylistTracksViaPlayDl(url, requestedBy) {
    const playlist = await this._fetchYouTubePlaylistInfo(url);
    await playlist.fetch(this.maxPlaylistTracks);

    const videos = [];
    for (let page = 1; page <= playlist.total_pages && videos.length < this.maxPlaylistTracks; page += 1) {
      const items = playlist.page(page) ?? [];
      for (const item of items) {
        videos.push(item);
        if (videos.length >= this.maxPlaylistTracks) break;
      }
    }

    if (!videos.length && Array.isArray(playlist.videos)) {
      videos.push(...playlist.videos.slice(0, this.maxPlaylistTracks));
    }

    return videos.map((video) => this._buildTrack({
      title: video.title,
      url: video.url,
      duration: video.durationRaw,
      thumbnailUrl: pickThumbnailUrlFromItem(video),
      requestedBy,
      source: 'youtube-playlist',
      artist: pickTrackArtistFromMetadata(video),
    }));
  }

  async _resolveYouTubePlaylistTracksViaYtDlp(url, requestedBy) {
    const safeLimit = Math.max(1, Number.parseInt(String(this.maxPlaylistTracks ?? 25), 10) || 25);
    const args = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end', String(safeLimit),
    ];

    if (this.ytdlpYoutubeClient) {
      args.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      args.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }

    args.push(url);
    const { stdout } = await this._runYtDlpCommand(args, 25_000);
    if (!stdout?.trim()) return [];

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return [];
    }

    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : [];

    const tracks = [];
    for (const entry of entries) {
      if (tracks.length >= safeLimit) break;
      const videoUrl = normalizeYouTubeVideoUrlFromEntry(entry);
      if (!videoUrl) continue;

      const title = String(entry?.title ?? '').trim() || videoUrl;
      const duration = Number.isFinite(entry?.duration) ? entry.duration : 'Unknown';
      tracks.push(this._buildTrack({
        title,
        url: videoUrl,
        duration,
        thumbnailUrl: pickThumbnailUrlFromItem(entry),
        requestedBy,
        source: 'youtube-playlist-ytdlp',
        artist: pickTrackArtistFromMetadata(entry),
      }));
    }

    return tracks;
  }

  _ffmpegHttpArgs(inputUrl, seekSec = 0) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);

    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-i', inputUrl,
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  }

  _cloneTrack(track, overrides = {}) {
    const next = {
      ...track,
      ...overrides,
    };
    next.id = overrides.id ?? buildTrackId();
    next.queuedAt = overrides.queuedAt ?? Date.now();
    return next;
  }

  _trackKey(track) {
    if (!track) return null;
    const url = String(track.url ?? '').trim().toLowerCase();
    if (url) return `url:${url}`;
    const title = String(track.title ?? '').trim().toLowerCase();
    return title ? `title:${title}` : null;
  }

  _hasDuplicateTrack(candidate) {
    const key = this._trackKey(candidate);
    if (!key) return false;

    if (this._trackKey(this.currentTrack) === key) return true;
    return this.pendingTracks.some((track) => this._trackKey(track) === key);
  }

  _rememberTrack(track) {
    if (!track) return;

    const snapshot = this._cloneTrack(track, {
      seekStartSec: 0,
      id: track.id,
      queuedAt: track.queuedAt,
    });
    this.trackHistory.push(snapshot);

    if (this.trackHistory.length > this.maxHistorySize) {
      this.trackHistory.splice(0, this.trackHistory.length - this.maxHistorySize);
    }
  }

  _parseDurationSeconds(value) {
    if (!value || typeof value !== 'string') return null;
    if (value.toLowerCase() === 'unknown') return null;

    const parts = value.split(':').map((part) => Number.parseInt(part, 10));
    if (!parts.every((part) => Number.isFinite(part))) return null;

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return null;
  }

  async _startPlayDlPipeline(url, seekSec = 0) {
    const options = { quality: 2 };
    if (seekSec > 0 && isYouTubeUrl(url)) {
      options.seek = seekSec;
    }

    const stream = await playdl.stream(url, options);
    this.sourceStream = stream.stream;

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceStream, 'source.stream');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    this.sourceStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });

    this.sourceStream.pipe(this.ffmpeg.stdin);
  }

  async _startYouTubePipeline(url, seekSec = 0) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    await this._startYtDlpPipeline(url, seekSec);
  }

  async _startYtDlpPipeline(url, seekSec = 0) {
    const attempts = this.ytdlpYoutubeClient
      ? [
          { format: 'bestaudio/best', includeClientArg: true },
          { format: 'bestaudio/best', includeClientArg: false },
          { format: null, includeClientArg: false },
        ]
      : [
          { format: 'bestaudio/best', includeClientArg: false },
          { format: null, includeClientArg: false },
        ];

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        await this._startYtDlpPipelineWithFormat(url, seekSec, attempt.format, attempt.includeClientArg);
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryableYtDlpStartupError(err)) {
          throw err;
        }

        this.logger?.warn?.('yt-dlp startup strategy failed, retrying with next strategy', {
          format: attempt.format ?? '(default)',
          includeClientArg: attempt.includeClientArg,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw lastErr ?? new Error('yt-dlp format selection failed');
  }

  async _startYtDlpPipelineWithFormat(url, seekSec = 0, formatSelector = 'bestaudio/best', includeClientArg = true) {
    this._lastYtDlpDiagnostics = {
      formatSelector: formatSelector ?? null,
      includeClientArg: Boolean(includeClientArg),
      selectedFormats: null,
      selectedItag: null,
      updatedAt: new Date().toISOString(),
    };

    this.sourceProc = await this._spawnYtDlp(url, formatSelector, includeClientArg);
    this.sourceProc.stderr?.setEncoding?.('utf8');

    let stderr = '';
    let stderrBuffer = '';
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const onStderr = (chunk) => {
      const text = String(chunk ?? '');
      stderr = `${stderr}${text}`.slice(-4096);
      this._trackYtDlpFormatSelection(text);

      if (!ytdlpVerboseEnabled) return;
      stderrBuffer = `${stderrBuffer}${text}`;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.logger?.info?.('yt-dlp verbose', { line: trimmed });
        }
      }
    };
    this.sourceProc.stderr?.on?.('data', onStderr);

    const ffmpegArgs = this._ffmpegArgs(seekSec);
    this._lastFfmpegArgs = [...ffmpegArgs];
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceProc.stdout, 'sourceProc.stdout');
    this._bindPipelineErrorHandler(this.sourceProc.stderr, 'sourceProc.stderr');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    this.sourceProc.stdout.pipe(this.ffmpeg.stdin);
    this.sourceProc.once('close', () => {
      this.ffmpeg?.stdin?.end();
    });

    try {
      const waitTimeoutMs = seekSec > 0
        ? Math.min(45_000, 10_000 + (Math.max(0, Number.parseInt(String(seekSec), 10) || 0) * 50))
        : 10_000;
      await this._awaitProcessOutput(this.sourceProc, waitTimeoutMs);
    } catch (err) {
      if (stderr.trim()) {
        throw new Error(stderr.trim().split('\n').slice(-2).join(' | '));
      }
      throw err;
    } finally {
      if (ytdlpVerboseEnabled) {
        const trailing = stderrBuffer.trim();
        if (trailing) {
          this.logger?.info?.('yt-dlp verbose', { line: trailing });
        }
      }
      this.sourceProc.stderr?.off?.('data', onStderr);
    }
  }

  _ffmpegArgs(seekSec = 0, options = {}) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const realtimeInput = options?.realtimeInput === true;

    const args = [
      ...(realtimeInput ? ['-re'] : []),
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
    ];

    if (seek > 0) {
      // Output-side seek keeps yt-dlp fallback usable even when play-dl seek fails.
      args.push('-ss', String(seek));
    }

    args.push(
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  }

  _buildTranscodeFilterChain() {
    const filters = [];

    if (this.pitchSemitones !== 0) {
      const rateFactor = 2 ** (this.pitchSemitones / 12);
      filters.push(`asetrate=48000*${rateFactor.toFixed(6)}`);
      filters.push('aresample=48000');
    }

    if (this.tempoRatio !== 1) {
      filters.push(`atempo=${this.tempoRatio.toFixed(3)}`);
    }

    const presetFilters = FILTER_PRESETS[this.filterPreset] ?? FILTER_PRESETS.off;
    if (!isLiveFilterPresetSupported(this.filterPreset)) {
      filters.push(...presetFilters);
    }
    return filters.join(',');
  }

  isLiveFilterPresetSupported(name = this.filterPreset) {
    return isLiveFilterPresetSupported(name);
  }

  _getLiveAudioProcessorState() {
    return {
      volumePercent: clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent),
      filterPreset: this.isLiveFilterPresetSupported(this.filterPreset) ? this.filterPreset : 'off',
      eqPreset: this.eqPreset,
    };
  }

  _createLiveAudioProcessor() {
    return new LiveAudioProcessor(this._getLiveAudioProcessorState());
  }

  _syncLiveAudioProcessor() {
    if (!this.liveAudioProcessor) return false;
    try {
      this.liveAudioProcessor.updateSettings(this._getLiveAudioProcessorState());
      return true;
    } catch (err) {
      this.logger?.warn?.('Failed to sync live audio processor state', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async _spawnYtDlp(url, formatSelector = 'bestaudio/best', includeClientArg = true) {
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const commonArgs = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', 'fragment:1:3',
    ];
    if (!ytdlpVerboseEnabled) {
      commonArgs.push('--quiet');
    }

    if (formatSelector) {
      commonArgs.push('-f', formatSelector);
    }

    if (includeClientArg && this.ytdlpYoutubeClient) {
      commonArgs.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      commonArgs.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }
    if (this.ytdlpExtraArgs.length) {
      commonArgs.push(...this.ytdlpExtraArgs);
    }

    commonArgs.push('-o', '-', url);
    const candidates = [];

    if (this.ytdlpBin) {
      candidates.push([this.ytdlpBin, commonArgs]);
    }

    candidates.push(
      ['yt-dlp', commonArgs],
      ['yt_dlp', commonArgs],
      ['py', ['-m', 'yt_dlp', ...commonArgs]],
      ['python', ['-m', 'yt_dlp', ...commonArgs]],
      ['python3', ['-m', 'yt_dlp', ...commonArgs]]
    );

    let lastErr = null;
    for (const [cmd, args] of candidates) {
      try {
        return await this._spawnProcess(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    throw new Error(`yt-dlp not found (${lastErr?.message ?? 'command not available'})`);
  }

  _isYtDlpVerboseEnabled() {
    if (!Array.isArray(this.ytdlpExtraArgs) || !this.ytdlpExtraArgs.length) return false;
    return this.ytdlpExtraArgs.some((arg) => {
      const token = String(arg ?? '').trim();
      return token === '--verbose' || token === '-v';
    });
  }

  _trackYtDlpFormatSelection(stderrChunk) {
    const text = String(stderrChunk ?? '');
    if (!text) return;

    const selectedMatch = text.match(/Downloading\s+\d+\s+format\(s\):\s*([^\r\n]+)/i);
    if (selectedMatch?.[1]) {
      const selectedFormats = String(selectedMatch[1]).trim();
      const itagMatch = selectedFormats.match(/\b(\d{2,4})\b/);
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedFormats,
        selectedItag: itagMatch?.[1] ?? this._lastYtDlpDiagnostics?.selectedItag ?? null,
        updatedAt: new Date().toISOString(),
      };
      return;
    }

    const itagMatch = text.match(/[?&]itag=(\d{2,4})\b/i);
    if (itagMatch?.[1]) {
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedItag: itagMatch[1],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async _searchWithYtDlp(query, limit = 1) {
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 1));
    const searchExpr = `ytsearch${safeLimit}:${query}`;
    const commonArgs = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
    ];

    if (this.ytdlpYoutubeClient) {
      commonArgs.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      commonArgs.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }

    commonArgs.push(searchExpr);
    const { stdout } = await this._runYtDlpCommand(commonArgs, 15_000);

    if (!stdout?.trim()) return [];
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return [];
    }

    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : (payload ? [payload] : []);

    return entries
      .map((entry) => {
        const id = String(entry?.id ?? '').trim();
        const url = String(entry?.webpage_url ?? entry?.url ?? '').trim() || (id ? `https://www.youtube.com/watch?v=${id}` : null);
        const title = String(entry?.title ?? '').trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          duration: entry?.duration ?? null,
          thumbnailUrl: pickThumbnailUrlFromItem(entry),
          artist: pickTrackArtistFromMetadata(entry),
        };
      })
      .filter(Boolean);
  }

  async _runYtDlpCommand(args, timeoutMs = 12_000) {
    const candidates = [];
    if (this.ytdlpBin) candidates.push(this.ytdlpBin);
    candidates.push('yt-dlp', 'yt_dlp', 'py', 'python', 'python3');

    let lastErr = null;
    for (const cmd of candidates) {
      let proc;
      try {
        if (cmd === 'python3' || cmd === 'python' || cmd === 'py') {
          proc = await this._spawnProcess(cmd, ['-m', 'yt_dlp', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } else {
          proc = await this._spawnProcess(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          lastErr = err;
          continue;
        }
        throw err;
      }

      const output = await this._collectProcessOutput(proc, timeoutMs).catch((err) => {
        throw err;
      });
      if (output.code === 0) return output;

      lastErr = new Error(output.stderr?.trim() || `yt-dlp exited with code ${output.code}`);
    }

    throw lastErr ?? new Error('yt-dlp command failed');
  }

  _collectProcessOutput(proc, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error('yt-dlp metadata command timed out.'));
      }, timeoutMs);

      proc.stdout?.setEncoding?.('utf8');
      proc.stderr?.setEncoding?.('utf8');
      proc.stdout?.on?.('data', (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-2_000_000);
      });
      proc.stderr?.on?.('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });

      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const exitCode = Number.isFinite(code) ? code : 1;
        if (signal) {
          reject(new Error(`yt-dlp metadata command terminated by signal ${signal}.`));
          return;
        }
        resolve({ code: exitCode, stdout, stderr });
      });
    });
  }

  _awaitProcessOutput(proc, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawOutput = false;
      const timeout = setTimeout(() => {
        if (settled || sawOutput) return;
        cleanup();
        reject(new Error('yt-dlp did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        sawOutput = true;
        if (settled) return;
        cleanup();
        resolve();
      };

      const onClose = (code, signal) => {
        if (settled || sawOutput) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`yt-dlp exited before output (code=${codeLabel}${signalLabel}).`));
      };

      const onError = (err) => {
        if (settled || sawOutput) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        proc.stdout?.off?.('data', onData);
        proc.off?.('close', onClose);
        proc.off?.('error', onError);
      };

      proc.stdout?.on?.('data', onData);
      proc.on?.('close', onClose);
      proc.on?.('error', onError);
    });
  }

  _awaitInitialPlaybackChunk(stream, proc, timeoutMs = 8_000) {
    if (!stream?.once || !stream?.off) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Playback pipeline did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        if (settled) return;
        cleanup();
        resolve();
      };

      const onStreamError = (err) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcError = (err) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcClose = (code, signal) => {
        if (settled) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`Playback pipeline exited before audio output (code=${codeLabel}${signalLabel}).`));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        stream.off?.('data', onData);
        stream.off?.('error', onStreamError);
        proc?.off?.('error', onProcError);
        proc?.off?.('close', onProcClose);
      };

      stream.once('data', onData);
      stream.once('error', onStreamError);
      proc?.once?.('error', onProcError);
      proc?.once?.('close', onProcClose);
    });
  }

  _getInitialPlaybackChunkTimeoutMs(track) {
    const seekSec = Math.max(0, Number.parseInt(String(track?.seekStartSec ?? 0), 10) || 0);
    if (seekSec <= 0) return 8_000;

    // Pipe-based seek startup can take longer on large offsets before the first PCM chunk appears.
    return Math.min(60_000, 8_000 + (seekSec * 10));
  }

  _spawnProcess(cmd, args, options) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, options);
      let settled = false;

      proc.once('spawn', () => {
        settled = true;
        resolve(proc);
      });

      proc.once('error', (err) => {
        if (!settled) {
          reject(err);
        }
      });
    });
  }

  _cleanupProcesses() {
    cleanupProcesses(this);
  }

  _clearPipelineState() {
    clearPipelineState(this);
  }

  _stopVoiceStream() {
    stopVoiceStream(this);
  }

  _clearPipelineErrorHandlers() {
    clearPipelineErrorHandlers(this);
  }

  _bindPipelineErrorHandler(stream, label) {
    bindPipelineErrorHandler(this, stream, label);
  }

  _isExpectedPipeError(err) {
    return isExpectedPipeError(err);
  }

  _startPlaybackClock(offsetSec) {
    startPlaybackClock(this, offsetSec);
  }

  _resetPlaybackClock() {
    resetPlaybackClock(this);
  }

  _normalizePlaybackError(err) {
    return normalizePlaybackError(this, err);
  }
}

Object.assign(MusicPlayer.prototype, sourceMethods);

