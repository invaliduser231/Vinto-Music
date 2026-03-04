import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import playdl from 'play-dl';
import { Queue } from './Queue.js';
import { ValidationError } from '../core/errors.js';

const LOOP_OFF = 'off';
const LOOP_TRACK = 'track';
const LOOP_QUEUE = 'queue';
const LOOP_MODES = new Set([LOOP_OFF, LOOP_TRACK, LOOP_QUEUE]);

const FILTER_PRESETS = {
  off: [],
  bassboost: ['bass=g=8:f=110:w=0.6'],
  nightcore: ['asetrate=48000*1.20', 'aresample=48000', 'atempo=1.05'],
  vaporwave: ['asetrate=48000*0.80', 'aresample=48000', 'atempo=0.95', 'lowpass=f=3200'],
  '8d': ['apulsator=hz=0.08'],
  soft: ['highshelf=f=8000:g=-6', 'lowshelf=f=120:g=-2'],
  karaoke: ['pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0'],
  radio: ['highpass=f=200', 'lowpass=f=3500', 'acompressor=threshold=-18dB:ratio=3:attack=20:release=250'],
};
FILTER_PRESETS.karoake = FILTER_PRESETS.karaoke;

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  pop: [2, 1, 0, 1, 2],
  rock: [4, 2, -1, 2, 4],
  edm: [5, 3, 0, 2, 4],
  vocal: [-1, 1, 3, 3, 1],
};
const EQ_BANDS = [90, 250, 1000, 4000, 12000];
const YT_PLAYLIST_RESOLVERS = new Set(['ytdlp', 'playdl']);

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host.includes('youtu.be')) {
      const segment = String(parsed.pathname ?? '').split('/').filter(Boolean)[0];
      return segment ? segment.trim() : null;
    }

    if (host.includes('youtube.com')) {
      const v = String(parsed.searchParams.get('v') ?? '').trim();
      return v || null;
    }

    return null;
  } catch {
    return null;
  }
}

function toCanonicalYouTubeWatchUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function buildYouTubeThumbnailFromUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function normalizeYouTubeVideoUrlFromEntry(entry) {
  const webpageUrl = String(entry?.webpage_url ?? '').trim();
  if (webpageUrl && isYouTubeUrl(webpageUrl)) return webpageUrl;

  const rawUrl = String(entry?.url ?? '').trim();
  if (rawUrl && isYouTubeUrl(rawUrl)) return rawUrl;

  const id = String(entry?.id ?? '').trim();
  if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  if (/^[\w-]{6,}$/.test(rawUrl)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(rawUrl)}`;
  }

  return null;
}

function getYouTubePlaylistId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;
    const list = String(parsed.searchParams.get('list') ?? '').trim();
    return list || null;
  } catch {
    return null;
  }
}

function toCanonicalYouTubePlaylistUrl(value) {
  const listId = getYouTubePlaylistId(value);
  if (!listId) return null;
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
}

function isSoundCloudUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('soundcloud.com') || parsed.hostname.includes('snd.sc') || parsed.hostname.includes('on.soundcloud.com');
  } catch {
    return false;
  }
}

function isDeezerUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('deezer.com') || parsed.hostname.includes('link.deezer.com');
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('spotify.com') || parsed.hostname.includes('spotify.link');
  } catch {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toDurationLabel(value) {
  if (value == null) return 'Unknown';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const total = Math.max(0, Math.floor(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return String(value);
}

function buildTrackId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pickArtistName(track) {
  if (Array.isArray(track?.artists) && track.artists[0]?.name) {
    return track.artists[0].name;
  }
  if (track?.artist?.name) return track.artist.name;
  if (track?.user?.name) return track.user.name;
  return null;
}

function isSpotifyAuthorizationError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('spotify data is missing')
    || message.includes('forgot to do authorization')
    || (message.includes('spotify') && message.includes('authorization'))
  );
}

function isSoundCloudAuthorizationError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('soundcloud data is missing')
    || message.includes('did you forget to do authorization')
    || (message.includes('soundcloud') && message.includes('authorization'))
  );
}

function spotifyAuthorizationHelp(sourceType) {
  if (sourceType === 'track') {
    return 'Spotify track lookup needs Spotify authorization in play-dl. For now use a normal search query or YouTube URL.';
  }

  return 'Spotify playlist/album lookup needs Spotify authorization in play-dl. For now use YouTube/SoundCloud playlist URLs or add tracks individually.';
}

function soundCloudAuthorizationHelp() {
  return 'SoundCloud lookup needs SoundCloud authorization in play-dl. Falling back to YouTube search for this URL.';
}

function isYouTubeBotCheckError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('sign in to confirm') || message.includes('not a bot');
}

function isYtDlpModuleMissingError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('no module named yt_dlp')
    || message.includes('no module named yt-dlp')
    || message.includes('module named yt_dlp')
  );
}

function isConnectionRefusedError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('winerror 10061')
    || message.includes('connection refused')
    || message.includes('zielcomputer die verbindung verweigerte')
  );
}

function isRequestedFormatUnavailableError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('requested format is not available')
    || message.includes('format is not available')
  );
}

function isYtDlpOutputTimeoutError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('yt-dlp did not produce audio output in time');
}

function isYtDlpExitedBeforeOutputError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('yt-dlp exited before output');
}

function isRetryableYtDlpStartupError(err) {
  return (
    isRequestedFormatUnavailableError(err)
    || isYtDlpOutputTimeoutError(err)
    || isYtDlpExitedBeforeOutputError(err)
  );
}

function isPlayDlBrowseFailure(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('browseid')
    || message.includes("cannot read properties of undefined (reading 'browseid')")
    || (message.includes('cannot read properties of undefined') && message.includes('youtube'))
  );
}

function parseCsvArgs(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeYtDlpArgs(args) {
  const input = Array.isArray(args) ? args : [];
  if (!input.length) return [];

  const listValueFlags = new Set([
    '--js-runtimes',
    '--extractor-args',
    '--remote-components',
  ]);

  const normalized = [];
  for (let i = 0; i < input.length; i += 1) {
    const token = String(input[i] ?? '').trim();
    if (!token) continue;

    if (listValueFlags.has(token)) {
      const values = [];
      while (i + 1 < input.length) {
        const next = String(input[i + 1] ?? '').trim();
        if (!next || next.startsWith('--')) break;
        values.push(next);
        i += 1;
      }

      normalized.push(token);
      if (values.length) {
        normalized.push(values.join(','));
      }
      continue;
    }

    normalized.push(token);
  }

  return normalized;
}

function normalizeYouTubePlaylistResolver(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'ytdlp';
  if (YT_PLAYLIST_RESOLVERS.has(normalized)) return normalized;
  return 'ytdlp';
}

function sanitizeUrlToSearchQuery(url) {
  try {
    const parsed = new URL(url);
    const rawSegments = parsed.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    const ignored = new Set([
      'track', 'tracks', 'album', 'playlist', 'artist', 'user',
      'sets', 'music', 'intl-en', 'intl-de', 'intl-fr',
    ]);

    const meaningful = rawSegments.filter((segment) => !ignored.has(segment.toLowerCase()));
    if (!meaningful.length) return null;

    const queryParts = [];
    const primary = meaningful[meaningful.length - 1];
    const secondary = meaningful.length > 1 ? meaningful[meaningful.length - 2] : null;

    if (secondary && !/^\d+$/.test(secondary)) {
      queryParts.push(secondary);
    }
    if (primary && !/^\d+$/.test(primary)) {
      queryParts.push(primary);
    }

    if (!queryParts.length) return null;

    const normalized = queryParts.join(' ')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || /^\d+$/.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function normalizeThumbnailUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) return null;
  return raw.slice(0, 2048);
}

function pickThumbnailUrlFromItem(item) {
  if (!item || typeof item !== 'object') return null;

  const directCandidates = [
    item.thumbnail?.url,
    item.thumbnailURL,
    item.thumbnail_url,
    item.thumbnail,
    item.image?.url,
    item.image,
    item.artwork_url,
    item.artworkUrl,
    item.cover_url,
    item.coverUrl,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeThumbnailUrl(candidate);
    if (normalized) return normalized;
  }

  const listCandidates = [
    item.thumbnails,
    item.images,
    item.video_details?.thumbnails,
    item.videoDetails?.thumbnails,
  ];

  for (const list of listCandidates) {
    if (!Array.isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      const normalized = normalizeThumbnailUrl(entry?.url ?? entry);
      if (normalized) return normalized;
    }
  }

  return null;
}

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
    this.pipelineErrorHandlers = [];

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
    return this.volumePercent;
  }

  setFilterPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase() || 'off';
    if (!FILTER_PRESETS[normalized]) {
      throw new ValidationError(`Unknown filter preset: ${name}`);
    }

    this.filterPreset = normalized;
    return this.filterPreset;
  }

  setEqPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!EQ_PRESETS[normalized]) {
      throw new ValidationError(`Unknown EQ preset: ${name}`);
    }

    this.eqPreset = normalized;
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
    this._cleanupProcesses();
    return true;
  }

  refreshCurrentTrackProcessing() {
    if (!this.playing || !this.currentTrack) return false;

    // Mid-track seek restarts are significantly more likely to trigger YouTube challenge failures.
    // For effect reprocessing, prefer a clean restart from 0 for stability.
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this.skipRequested = true;
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
      this.emit('queueEmpty');
      return;
    }

    this.playing = true;
    this.paused = false;
    this.skipRequested = false;

    try {
      this._clearPipelineState();

      if (isYouTubeUrl(track.url)) {
        await this._startYouTubePipeline(track.url, track.seekStartSec ?? 0);
      } else {
        await this._startPlayDlPipeline(track.url, 0);
      }

      await this.voice.sendAudio(this.ffmpeg.stdout);
      this._startPlaybackClock(track.seekStartSec ?? 0);
      this.emit('trackStart', track);
      this.logger?.info?.('Playback started', { title: track.title, url: track.url, seek: track.seekStartSec ?? 0 });

      this.ffmpeg.once('close', async (code, signal) => {
        await this._handleTrackClose(track, code, signal);
      });
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

      this.emit('queueEmpty');
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
    this._cleanupProcesses();
    return true;
  }

  stop() {
    this.skipRequested = true;
    this.pendingSeekTrack = null;
    this.queue.clear();
    this._cleanupProcesses();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();
  }

  async _handleTrackClose(track, code, signal) {
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

    const url = await this._normalizeInputUrl(raw);
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
          fallbackWatchUrl: toCanonicalYouTubeWatchUrl(url),
        });
      case 'so_track':
        return this._resolveSoundCloudTrack(url, requestedBy);
      case 'so_playlist':
        return this._resolveSoundCloudPlaylist(url, requestedBy);
      case 'sp_track':
        return this._resolveSpotifyTrack(url, requestedBy);
      case 'sp_playlist':
      case 'sp_album':
        return this._resolveSpotifyCollection(url, requestedBy);
      case 'dz_track':
        return this._resolveDeezerTrack(url, requestedBy);
      case 'dz_playlist':
      case 'dz_album':
        return this._resolveDeezerCollection(url, requestedBy);
      default:
        if (isSoundCloudUrl(url)) {
          return this._resolveSoundCloudByGuess(url, requestedBy);
        }
        if (isDeezerUrl(url)) {
          return this._resolveDeezerByGuess(url, requestedBy);
        }
        if (isSpotifyUrl(url)) {
          return this._resolveSpotifyByGuess(url, requestedBy);
        }

        return this._resolveSingleUrlTrack(url, requestedBy);
    }
  }

  async _resolveSearchTrack(query, requestedBy) {
    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(async (err) => {
      if (!isPlayDlBrowseFailure(err)) throw err;
      this.logger?.warn?.('play-dl search failed, trying yt-dlp search fallback', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._searchWithYtDlp(query, 1);
    });
    if (!result.length) return [];

    return [this._buildTrack({
      title: result[0].title,
      url: result[0].url,
      duration: result[0].durationRaw ?? result[0].duration,
      thumbnailUrl: pickThumbnailUrlFromItem(result[0]),
      requestedBy,
      source: 'youtube-search',
    })];
  }

  async searchCandidates(query, limit = 5, options = {}) {
    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const requestedBy = options.requestedBy ?? null;
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit: safeLimit }).catch(async (err) => {
      if (!isPlayDlBrowseFailure(err)) throw err;
      this.logger?.warn?.('play-dl searchCandidates failed, trying yt-dlp search fallback', {
        query,
        limit: safeLimit,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._searchWithYtDlp(query, safeLimit);
    });
    return results.map((item) => this._buildTrack({
      title: item.title,
      url: item.url,
      duration: item.durationRaw ?? item.duration,
      thumbnailUrl: pickThumbnailUrlFromItem(item),
      requestedBy,
      source: 'youtube-search',
    }));
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
    return this._buildTrack({
      title: data?.title,
      url: data?.url,
      duration: data?.duration,
      thumbnailUrl: data?.thumbnailUrl ?? data?.thumbnail_url ?? data?.thumbnail,
      requestedBy,
      source: data?.source ?? 'stored',
    });
  }

  async _resolveSingleYouTubeTrack(url, requestedBy) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    try {
      const info = await playdl.video_info(url);
      return [this._buildTrack({
        title: info.video_details.title,
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'youtube',
      })];
    } catch {
      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'youtube',
      })];
    }
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

    const watchUrl = options.fallbackWatchUrl ?? toCanonicalYouTubeWatchUrl(url);
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
      }));
    }

    return tracks;
  }

  async _resolveSoundCloudTrack(url, requestedBy) {
    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'track') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    return this._resolveCrossSourceToYouTube([data], requestedBy, 'soundcloud');
  }

  async _resolveSoundCloudPlaylist(url, requestedBy) {
    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'playlist') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    const tracks = await data.all_tracks();
    return this._resolveCrossSourceToYouTube(
      tracks.slice(0, this.maxPlaylistTracks),
      requestedBy,
      'soundcloud-playlist'
    );
  }

  async _resolveSpotifyTrack(url, requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }

    let data;
    try {
      data = await playdl.spotify(url);
    } catch (err) {
      if (isSpotifyAuthorizationError(err)) {
        throw new ValidationError(spotifyAuthorizationHelp('track'));
      }
      throw err;
    }

    if (!data || data.type !== 'track') return [];

    return this._resolveCrossSourceToYouTube([data], requestedBy, 'spotify');
  }

  async _resolveSpotifyCollection(url, requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }

    let data;
    try {
      data = await playdl.spotify(url);
    } catch (err) {
      if (isSpotifyAuthorizationError(err)) {
        throw new ValidationError(spotifyAuthorizationHelp('collection'));
      }
      throw err;
    }

    if (!data || (data.type !== 'playlist' && data.type !== 'album')) return [];

    const tracks = await data.all_tracks();
    return this._resolveCrossSourceToYouTube(tracks.slice(0, this.maxPlaylistTracks), requestedBy, `spotify-${data.type}`);
  }

  async _resolveDeezerTrack(url, requestedBy) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    const data = await playdl.deezer(url);
    if (!data || data.type !== 'track') return [];

    return this._resolveCrossSourceToYouTube([data], requestedBy, 'deezer');
  }

  async _resolveDeezerCollection(url, requestedBy) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    const data = await playdl.deezer(url);
    if (!data || (data.type !== 'playlist' && data.type !== 'album')) return [];

    const tracks = await data.all_tracks();
    return this._resolveCrossSourceToYouTube(tracks.slice(0, this.maxPlaylistTracks), requestedBy, `deezer-${data.type}`);
  }

  async _resolveCrossSourceToYouTube(sourceTracks, requestedBy, source) {
    if (!this.enableYtSearch) {
      throw new ValidationError('Cross-source imports require YouTube search, which is currently disabled.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('Cross-source imports require YouTube playback, which is currently disabled.');
    }

    const resolved = [];

    for (const sourceTrack of sourceTracks) {
      const title = sourceTrack.title || sourceTrack.name || 'Unknown title';
      const artist = pickArtistName(sourceTrack);
      const query = artist ? `${artist} - ${title}` : title;

      const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(() => []);
      if (!result.length) continue;

      resolved.push(this._buildTrack({
        title: result[0].title || title,
        url: result[0].url,
        duration: result[0].durationRaw || toDurationLabel(sourceTrack.durationInSec),
        thumbnailUrl: pickThumbnailUrlFromItem(result[0]),
        requestedBy,
        source,
      }));
    }

    if (!resolved.length) {
      throw new ValidationError(`No playable YouTube matches found for ${source} source.`);
    }

    return resolved;
  }

  async _resolveSingleUrlTrack(url, requestedBy) {
    try {
      const info = await playdl.video_info(url);
      return [this._buildTrack({
        title: info.video_details.title,
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'url',
      })];
    } catch {
      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'url',
      })];
    }
  }

  async _resolveSoundCloudByGuess(url, requestedBy) {
    try {
      if (url.includes('/sets/')) {
        return await this._resolveSoundCloudPlaylist(url, requestedBy);
      }
      return await this._resolveSoundCloudTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }
  }

  async _resolveDeezerByGuess(url, requestedBy) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveDeezerCollection(url, requestedBy);
      }
      return await this._resolveDeezerTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'deezer-fallback');
    }
  }

  async _resolveSpotifyByGuess(url, requestedBy) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveSpotifyCollection(url, requestedBy);
      }
      return await this._resolveSpotifyTrack(url, requestedBy);
    } catch (err) {
      if (isSpotifyAuthorizationError(err)) {
        throw new ValidationError(spotifyAuthorizationHelp('collection'));
      }
      throw err;
    }
  }

  async _resolveFromUrlFallbackSearch(url, requestedBy, source) {
    if (!this.enableYtSearch) {
      throw new ValidationError(`Could not resolve ${source} URL because YouTube search is disabled.`);
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError(`Could not resolve ${source} URL because YouTube playback is disabled.`);
    }

    const query = sanitizeUrlToSearchQuery(url);
    if (!query) {
      throw new ValidationError(`Could not resolve ${source} URL to a playable track.`);
    }

    const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(() => []);
    if (!result.length) {
      throw new ValidationError(`Could not resolve ${source} URL to a playable track.`);
    }

    return [this._buildTrack({
      title: result[0].title || query,
      url: result[0].url,
      duration: result[0].durationRaw,
      thumbnailUrl: pickThumbnailUrlFromItem(result[0]),
      requestedBy,
      source,
    })];
  }

  async _normalizeInputUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (!isHttpUrl(trimmed)) return trimmed;

    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === 'music.youtube.com') {
        parsed.hostname = 'www.youtube.com';
        return parsed.toString();
      }
      const shouldExpand = parsed.hostname.includes('link.deezer.com') || parsed.hostname.includes('on.soundcloud.com');

      if (shouldExpand) {
        const response = await fetch(trimmed, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(7_000),
        }).catch(() => null);

        if (response?.url && isHttpUrl(response.url)) {
          return response.url;
        }
      }
    } catch {
      return trimmed;
    }

    return trimmed;
  }

  _buildTrack({ title, url, duration, thumbnailUrl = null, requestedBy, source, artist = null, seekStartSec = 0 }) {
    const normalizedThumbnail = normalizeThumbnailUrl(thumbnailUrl) ?? buildYouTubeThumbnailFromUrl(url);
    return {
      id: buildTrackId(),
      title: title || 'Unknown title',
      url,
      duration: toDurationLabel(duration),
      thumbnailUrl: normalizedThumbnail,
      requestedBy,
      source,
      artist: artist ? String(artist).slice(0, 128) : null,
      queuedAt: Date.now(),
      seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec), 10) || 0),
    };
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
          { format: 'best', includeClientArg: true },
          { format: 'bestaudio/best', includeClientArg: false },
          { format: 'best', includeClientArg: false },
          { format: null, includeClientArg: false },
        ]
      : [
          { format: 'bestaudio/best', includeClientArg: false },
          { format: 'best', includeClientArg: false },
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
    this.sourceProc = await this._spawnYtDlp(url, formatSelector, includeClientArg);
    this.sourceProc.stderr?.setEncoding?.('utf8');

    let stderr = '';
    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    };
    this.sourceProc.stderr?.on?.('data', onStderr);

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(seekSec), {
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
      this.sourceProc.stderr?.off?.('data', onStderr);
    }
  }

  _ffmpegArgs(seekSec = 0) {
    const normalizedVolume = clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent);
    const volumeFactor = (normalizedVolume / 100).toFixed(2);
    const filterChain = this._buildAudioFilterChain(volumeFactor);
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);

    const args = [
      '-i', 'pipe:0',
    ];

    if (seek > 0) {
      // Output-side seek keeps yt-dlp fallback usable even when play-dl seek fails.
      args.push('-ss', String(seek));
    }

    args.push(
      '-ac', '2',
      '-ar', '48000',
      '-af', filterChain,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  }

  _buildAudioFilterChain(volumeFactor) {
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
    filters.push(...presetFilters);

    const eqGains = EQ_PRESETS[this.eqPreset] ?? EQ_PRESETS.flat;
    for (let i = 0; i < EQ_BANDS.length; i += 1) {
      const gain = eqGains[i] ?? 0;
      if (gain === 0) continue;
      filters.push(`equalizer=f=${EQ_BANDS[i]}:t=q:w=1:g=${gain}`);
    }

    filters.push(`volume=${volumeFactor}`);
    return filters.join(',');
  }

  async _spawnYtDlp(url, formatSelector = 'bestaudio/best', includeClientArg = true) {
    const commonArgs = [
      '--ignore-config',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--no-progress',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', 'fragment:1:3',
    ];

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
        };
      })
      .filter(Boolean);
  }

  async _runYtDlpCommand(args, timeoutMs = 12_000) {
    const candidates = [];
    if (this.ytdlpBin) candidates.push(this.ytdlpBin);
    candidates.push('yt-dlp', 'yt_dlp', 'python', 'python3');

    let lastErr = null;
    for (const cmd of candidates) {
      let proc;
      try {
        if (cmd === 'python3' || cmd === 'python') {
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
    try {
      if (this.sourceProc?.stdout && this.ffmpeg?.stdin) {
        this.sourceProc.stdout.unpipe(this.ffmpeg.stdin);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      if (this.sourceStream && this.ffmpeg?.stdin) {
        this.sourceStream.unpipe(this.ffmpeg.stdin);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      this.sourceStream?.destroy?.();
    } catch {
      // ignore source stream teardown errors
    }

    this.sourceStream = null;
    this.sourceProc?.kill('SIGKILL');
    this.sourceProc = null;

    try {
      this.ffmpeg?.stdin?.destroy?.();
    } catch {
      // ignore stdin teardown errors
    }

    this.ffmpeg?.kill('SIGKILL');
    this.ffmpeg = null;
    this._clearPipelineErrorHandlers();
  }

  _clearPipelineState() {
    this._clearPipelineErrorHandlers();
    this.sourceStream = null;
  }

  _clearPipelineErrorHandlers() {
    for (const unbind of this.pipelineErrorHandlers) {
      try {
        unbind();
      } catch {
        // ignore listener cleanup errors
      }
    }
    this.pipelineErrorHandlers = [];
  }

  _bindPipelineErrorHandler(stream, label) {
    if (!stream?.on || !stream?.off) return;

    const onError = (err) => {
      if (this._isExpectedPipeError(err)) {
        this.logger?.debug?.('Ignoring expected pipeline error', {
          label,
          code: err?.code ?? null,
        });
        return;
      }

      this.logger?.warn?.('Pipeline stream error', {
        label,
        code: err?.code ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    };

    stream.on('error', onError);
    this.pipelineErrorHandlers.push(() => {
      stream.off('error', onError);
    });
  }

  _isExpectedPipeError(err) {
    const code = err?.code;
    return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
  }

  _startPlaybackClock(offsetSec) {
    this.currentTrackOffsetSec = Math.max(0, Number.parseInt(String(offsetSec), 10) || 0);
    this.trackStartedAtMs = Date.now();
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
  }

  _resetPlaybackClock() {
    this.trackStartedAtMs = null;
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
    this.currentTrackOffsetSec = 0;
  }

  _normalizePlaybackError(err) {
    if (err?.code === 'ENOENT' && (err?.path === this.ffmpegBin || err?.path === 'ffmpeg')) {
      return new Error('FFmpeg is not available. Install ffmpeg or set FFMPEG_BIN.');
    }
    if (err?.code === 'ENOENT' && /yt[_-]?dlp/i.test(String(err?.path ?? ''))) {
      return new Error('yt-dlp is not available. Install yt-dlp or set YTDLP_BIN.');
    }
    if (isYtDlpModuleMissingError(err)) {
      return new Error('yt-dlp Python module is missing. Install it with `python -m pip install yt-dlp` or set YTDLP_BIN to yt-dlp.exe.');
    }
    if (isConnectionRefusedError(err)) {
      return new Error('Network connection refused during media fetch. Check proxy env vars (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) and remove localhost:9 mappings.');
    }
    if (isYouTubeBotCheckError(err)) {
      return new Error(
        'YouTube requested bot verification. Configure YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER and update yt-dlp.'
      );
    }

    if (err instanceof ValidationError) return err;
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
}
