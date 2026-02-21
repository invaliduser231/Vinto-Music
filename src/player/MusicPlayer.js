import { EventEmitter } from 'events';
import { spawn } from 'child_process';
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

function isBenignYouTubeFallbackError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('invalid url')
    || message.includes('video id')
    || message.includes('playability')
    || message.includes('signature')
  );
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

export class MusicPlayer extends EventEmitter {
  constructor(voice, options = {}) {
    super();
    this.voice = voice;
    this.queue = new Queue();
    this.logger = options.logger;

    this.ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || ffmpegPath || 'ffmpeg';
    this.ytdlpBin = options.ytdlpBin || process.env.YTDLP_BIN || null;

    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.maxPlaylistTracks = options.maxPlaylistTracks ?? 25;
    this.minVolumePercent = options.minVolumePercent ?? 0;
    this.maxVolumePercent = options.maxVolumePercent ?? 200;
    this.enableYtSearch = options.enableYtSearch !== false;
    this.enableYtPlayback = options.enableYtPlayback !== false;
    this.enableSpotifyImport = options.enableSpotifyImport !== false;
    this.enableDeezerImport = options.enableDeezerImport !== false;

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

    const restartFrom = this.canSeekCurrentTrack() ? this.getProgressSeconds() : 0;
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: restartFrom });
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

  async enqueueAutoplayTrack() {
    const seed = this.currentTrack ?? this.getLastHistoryTrack();
    if (!seed) return null;

    const query = seed.title;
    const results = await playdl.search(query, {
      source: { youtube: 'video' },
      limit: 8,
    }).catch(() => []);

    if (!results.length) return null;

    for (const result of results) {
      const candidate = this._buildTrack({
        title: result.title,
        url: result.url,
        duration: result.durationRaw,
        requestedBy: 'autoplay',
        source: 'autoplay',
      });

      if (this._hasDuplicateTrack(candidate)) continue;
      if (seed.url && candidate.url === seed.url) continue;

      this.queue.add(candidate);
      this.emit('tracksAdded', [candidate]);
      return candidate;
    }

    return null;
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
    const input = Array.isArray(tracks) ? tracks : [];
    if (!input.length) return [];

    const filteredTracks = dedupe
      ? input.filter((track) => !this._hasDuplicateTrack(track))
      : input;

    if (!filteredTracks.length) {
      return [];
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
    this._startPlaybackClock(track.seekStartSec ?? 0);

    this.emit('trackStart', track);
    this.logger?.info?.('Playback started', { title: track.title, url: track.url, seek: track.seekStartSec ?? 0 });

    try {
      this._clearPipelineState();

      if (isYouTubeUrl(track.url)) {
        await this._startYouTubePipeline(track.url, track.seekStartSec ?? 0);
      } else {
        await this._startPlayDlPipeline(track.url, 0);
      }

      await this.voice.sendAudio(this.ffmpeg.stdout);

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

    this.sourceProc?.kill('SIGSTOP');
    this.ffmpeg?.kill('SIGSTOP');

    this.paused = true;
    this.pauseStartedAtMs = Date.now();
    return true;
  }

  resume() {
    if (!this.playing || !this.paused) return false;

    this.sourceProc?.kill('SIGCONT');
    this.ffmpeg?.kill('SIGCONT');

    if (this.pauseStartedAtMs) {
      this.totalPausedMs += Date.now() - this.pauseStartedAtMs;
    }

    this.pauseStartedAtMs = null;
    this.paused = false;
    return true;
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

    switch (validation) {
      case 'yt_video':
        return this._resolveSingleYouTubeTrack(url, requestedBy);
      case 'yt_playlist':
        return this._resolveYouTubePlaylistTracks(url, requestedBy);
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

    const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
    if (!result.length) return [];

    return [this._buildTrack({
      title: result[0].title,
      url: result[0].url,
      duration: result[0].durationRaw,
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
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit: safeLimit });
    return results.map((item) => this._buildTrack({
      title: item.title,
      url: item.url,
      duration: item.durationRaw,
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

  async _resolveYouTubePlaylistTracks(url, requestedBy) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const playlist = await playdl.playlist_info(url, { incomplete: true });
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
      requestedBy,
      source: 'youtube-playlist',
    }));
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
      requestedBy,
      source,
    })];
  }

  async _normalizeInputUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (!isHttpUrl(trimmed)) return trimmed;

    try {
      const parsed = new URL(trimmed);
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

  _buildTrack({ title, url, duration, requestedBy, source, seekStartSec = 0 }) {
    return {
      id: buildTrackId(),
      title: title || 'Unknown title',
      url,
      duration: toDurationLabel(duration),
      requestedBy,
      source,
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

    try {
      await this._startPlayDlPipeline(url, seekSec);
      return;
    } catch (err) {
      if (seekSec > 0) {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      const logFn = isBenignYouTubeFallbackError(err) ? 'debug' : 'warn';
      this.logger?.[logFn]?.('play-dl youtube pipeline failed, trying yt-dlp fallback', {
        error: errorMessage,
      });
    }

    await this._startYtDlpPipeline(url);
  }

  async _startYtDlpPipeline(url) {
    this.sourceProc = await this._spawnYtDlp(url);

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceProc.stdout, 'sourceProc.stdout');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    this.sourceProc.stdout.pipe(this.ffmpeg.stdin);
    this.sourceProc.once('close', () => {
      this.ffmpeg?.stdin?.end();
    });
  }

  _ffmpegArgs() {
    const normalizedVolume = clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent);
    const volumeFactor = (normalizedVolume / 100).toFixed(2);
    const filterChain = this._buildAudioFilterChain(volumeFactor);

    return [
      '-i', 'pipe:0',
      '-ac', '2',
      '-ar', '48000',
      '-af', filterChain,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
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

  async _spawnYtDlp(url) {
    const commonArgs = ['--no-playlist', '--quiet', '--no-warnings', '-f', 'bestaudio/best', '-o', '-', url];
    const candidates = [];

    if (this.ytdlpBin) {
      candidates.push([this.ytdlpBin, commonArgs]);
    }

    candidates.push(
      ['yt-dlp', commonArgs],
      ['yt_dlp', commonArgs],
      ['python3', ['-m', 'yt_dlp', ...commonArgs]]
    );

    let lastErr = null;
    for (const [cmd, args] of candidates) {
      try {
        return await this._spawnProcess(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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

    if (err instanceof ValidationError) return err;
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
}
