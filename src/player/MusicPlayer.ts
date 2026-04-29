import { EventEmitter } from 'events';
import type { Writable } from 'node:stream';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { sourceMethods } from './musicPlayer/sourceMethods.ts';
import { AudiusClient } from './musicPlayer/AudiusClient.ts';
import { DeezerClient } from './musicPlayer/DeezerClient.ts';
import { ResolverClient } from './musicPlayer/ResolverClient.ts';
import { SoundCloudClient } from './musicPlayer/SoundCloudClient.ts';
import { SpotifyClient } from './musicPlayer/SpotifyClient.ts';
import { NodeLinkClient } from './musicPlayer/NodeLinkClient.ts';
import { playbackStateMethods } from './musicPlayer/playbackStateMethods.ts';
import { queueLifecycleMethods } from './musicPlayer/queueLifecycleMethods.ts';
import { resolverMethods } from './musicPlayer/resolverMethods.ts';
import { nodeLinkMethods } from './musicPlayer/nodeLinkMethods.ts';
import { pipelineMethods } from './musicPlayer/pipelineMethods.ts';
import { trackRuntimeMethods } from './musicPlayer/trackRuntimeMethods.ts';
import ffmpegPath from 'ffmpeg-static';
import { Queue } from './Queue.ts';
import { LiveAudioProcessor } from './LiveAudioProcessor.ts';
import { ValidationError } from '../core/errors.ts';
import {
  EQ_PRESETS,
  LOOP_MODES,
  LOOP_OFF,
  LOOP_QUEUE,
  LOOP_TRACK,
} from './musicPlayer/constants.ts';
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
} from './musicPlayer/deezer.ts';
import {
  isPlayDlBrowseFailure,
  isSoundCloudAuthorizationError,
  normalizeDeezerTrackFormats,
  normalizeYouTubePlaylistResolver,
  normalizeYtDlpArgs,
  parseCsvArgs,
  soundCloudAuthorizationHelp,
} from './musicPlayer/errorUtils.ts';
import {
  buildYouTubeThumbnailFromUrl,
  extractDeezerTrackId,
  getYouTubePlaylistId,
  isDeezerUrl,
  isHttpUrl,
  isSpotifyUrl,
  isYouTubeUrl,
  normalizeThumbnailUrl,
  pickArtistName,
  sanitizeUrlToSearchQuery,
  toAudiusDurationLabel,
  toCanonicalYouTubePlaylistUrl,
  toDeezerDurationLabel,
  toDurationLabel,
  toSoundCloudDurationLabel,
} from './musicPlayer/trackUtils.ts';
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
} from './musicPlayer/processUtils.ts';
import type { BivariantCallback, LoggerLike } from '../types/core.ts';
import type { PipelineProcess, Track, TrackInput } from '../types/domain.ts';

const NORMALIZED_INPUT_URL_CACHE_MAX_SIZE = 500;
const DEEZER_STREAM_META_CACHE_MAX_SIZE = 1_000;
const STARTUP_FAILURE_STREAK_LIMIT = 3;
const NEXT_TRACK_PREFETCH_TTL_MS = 10 * 60_000;

type YouTubePrefetchedStream = {
  streamUrl: string;
  proxyUrl: string | null;
};

type NodeLinkRoutingMode = 'smart' | 'all' | 'youtube-only';

function parseEnabledFlag(value: unknown, fallback = false): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeNodeLinkRoutingMode(value: unknown, fallback: NodeLinkRoutingMode = 'smart'): NodeLinkRoutingMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return fallback;
  if (normalized === 'smart' || normalized === 'all' || normalized === 'youtube-only') return normalized;
  if (normalized === 'youtube') return 'youtube-only';
  return fallback;
}

function getStartupRetryAttempt(track: Track | null | undefined): number {
  const rawValue = (track as (Track & { startupRetryCount?: unknown }) | null | undefined)?.startupRetryCount;
  const parsed = Number.parseInt(String(rawValue ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getStartupFallbackPipeline(track: Track | null | undefined): 'ytdlp-url' | 'ytdlp-proxy' | null {
  const fallback = (track as (Track & { startupFallbackPipeline?: unknown }) | null | undefined)?.startupFallbackPipeline;
  if (fallback === 'ytdlp-url' || fallback === 'ytdlp-proxy') return fallback;
  return null;
}

interface VoiceAdapterLike {
  sendAudio?: (stream: unknown) => Promise<unknown>;
  isStreaming?: boolean;
  connected?: boolean;
  channelId?: string | null;
  pauseAudio?: () => unknown;
  resumeAudio?: () => unknown;
  getDiagnostics?: () => Promise<unknown>;
}

class PlaybackStartupAbortedError extends Error {
  constructor(message = 'Playback startup aborted.') {
    super(message);
    this.name = 'PlaybackStartupAbortedError';
  }
}

interface MusicPlayerOptions {
  logger?: LoggerLike | null | undefined;
  ffmpegBin?: string | null;
  ytdlpBin?: string | null;
  ytdlpCookiesFile?: string | null;
  ytdlpCookiesFromBrowser?: string | null;
  ytdlpYoutubeClient?: string | null;
  ytdlpExtraArgs?: string[] | string | null;
  ytdlpProxyUrl?: string | null;
  maxQueueSize?: number;
  maxPlaylistTracks?: number;
  minVolumePercent?: number;
  maxVolumePercent?: number;
  enableYtSearch?: boolean;
  enableYtPlayback?: boolean;
  enableSpotifyImport?: boolean;
  enableDeezerImport?: boolean;
  enableTidalImport?: boolean;
  nodeLinkEnabled?: boolean;
  nodeLinkBaseUrl?: string | null;
  nodeLinkPassword?: string | null;
  nodeLinkDefaultSearch?: string | null;
  nodeLinkRoutingMode?: NodeLinkRoutingMode | string | null;
  nodeLinkRequestTimeoutMs?: number | null;
  nodeLinkStreamStartTimeoutMs?: number | null;
  spotifyClientId?: string | null;
  spotifyClientSecret?: string | null;
  spotifyRefreshToken?: string | null;
  spotifyMarket?: string | null;
  tidalToken?: string | null;
  tidalCountryCode?: string | null;
  appleMusicMediaApiToken?: string | null;
  appleMusicAutoToken?: boolean;
  appleMusicMarket?: string | null;
  deezerArl?: string | null;
  deezerTrackFormats?: string[] | string | null;
  soundcloudClientId?: string | null;
  soundcloudAutoClientId?: boolean;
  youtubePlaylistResolver?: string | null;
  enableYouTubePrefetchedPlayback?: boolean | null;
  defaultVolumePercent?: number;
  maxHistorySize?: number;
}

interface QueueGuardOption {
  enabled?: boolean;
  windowSize?: number;
  maxPerRequesterWindow?: number;
  maxArtistStreak?: number;
  [key: string]: unknown;
}

interface EnqueueOptions {
  requestedBy?: string | null;
  playNext?: boolean;
  dedupe?: boolean;
  queueGuard?: QueueGuardOption | null;
}

interface SearchOptions {
  requestedBy?: string | null;
}

interface PreviewOptions extends SearchOptions {
  limit?: number;
}

interface PlaylistResolveOptions {
  fallbackWatchUrl?: string | null;
  limit?: number | null;
}

type PipelineStreamLike = NonNullable<PipelineProcess['stdout']>;
type BuiltTrackInput = {
  title: string;
  url: string;
  duration: string | number | null | undefined;
  metadataDeferred?: boolean;
  thumbnailUrl?: string | null;
  requestedBy?: string | null | undefined;
  source: string;
  artist?: string | null;
  soundcloudTrackId?: string | null;
  audiusTrackId?: string | null;
  deezerTrackId?: string | null;
  deezerPreviewUrl?: string | null;
  deezerFullStreamUrl?: string | null;
  spotifyTrackId?: string | null;
  spotifyPreviewUrl?: string | null;
  isrc?: string | null;
  nodelinkEncodedTrack?: string | null;
  nodelinkInfo?: Record<string, unknown> | null;
  isPreview?: boolean;
  isLive?: boolean;
  seekStartSec?: number;
};
type SourceProcessCloseInfo = {
  code: number | null;
  signal: string | null;
  atMs: number;
  stderrTail: string | null;
  url: string | null;
};

export class MusicPlayer extends EventEmitter {
  [key: string]: unknown;
  declare stop: () => void;
  declare clearQueue: () => void;
  declare setVolumePercent: (value: number) => number;
  declare setLoopMode: (mode: string) => string;
  declare createTrackFromData: (track: TrackInput, requestedBy?: string | null) => Track;
  declare hydrateTrackMetadata: (
    track: TrackInput,
    options?: { requestedBy?: string | null }
  ) => Promise<Track | null>;
  declare previewTracks: (
    query: string,
    options: { requestedBy?: string | null; limit?: number }
  ) => Promise<Track[]>;
  declare getDiagnostics: () => unknown;
  declare getState: () => unknown;
  declare canSeekCurrentTrack: () => boolean;
  declare skip: () => boolean;
  declare pause: () => boolean;
  declare resume: () => boolean;
  declare seekTo: (seconds: number) => number;
  declare replayCurrentTrack: () => boolean;
  declare queuePreviousTrack: () => Track | null;
  declare searchCandidates: (
    query: string,
    limit?: number,
    options?: { requestedBy?: string | null }
  ) => Promise<Track[]>;
  declare _buildTrack: (input: BuiltTrackInput) => Track;
  declare _handleTrackClose: (track: Track, code: unknown, signal: unknown, playbackToken?: number | null) => Promise<void>;
  declare _resolveTracks: (query: string, requestedBy: string | null, limit?: number | null) => Promise<Track[]>;
  declare _resolveNodeLinkTracks: (
    query: string,
    requestedBy: string | null,
    limit?: number | null,
    options?: { searchIdentifier?: string | null }
  ) => Promise<Track[]>;
  declare _resolveYouTubeTrackViaNodeLink: (track: Partial<Track> | null | undefined) => Promise<Track | null>;
  declare _nodeLinkLoadResultToTracks: (result: unknown, requestedBy: string | null, limit?: number | null) => Track[];
  declare _nodeLinkTrackDataToTrack: (data: unknown, requestedBy: string | null) => Track | null;
  declare _resolveSearchTrack: (query: string, requestedBy: string | null) => Promise<Track[]>;
  declare _resolveAmazonTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveAmazonCollection: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveAppleTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveAppleCollection: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveAudiusByUrl: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveDeezerTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveDeezerCollection: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveDeezerByGuess: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveDeezerMediaVariantFromResponse: (body: unknown) => {
    url?: string | null;
    cipherType?: string | null;
    format?: string | null;
  } | null;
  declare _getDeezerSessionTokens: (forceRefresh?: boolean) => Promise<{
    apiToken: string | null;
    licenseToken: string | null;
    expiresAtMs: number;
  }>;
  declare _resolveDeezerFullStreamUrlWithArl: (trackId: unknown) => Promise<string | null>;
  declare _resolveSpotifyTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSpotifyCollection: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSpotifyArtist: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSpotifyByGuess: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveSpotifyMirror: BivariantCallback<[Partial<Track> | null | undefined, (string | null | undefined)?], Promise<Track[]>>;
  declare _spotifyApiRequest: (pathname: string, query?: Record<string, unknown>) => Promise<unknown>;
  declare _resolveTidalTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveTidalCollection: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveTidalMix: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveTidalByGuess: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _tidalApiRequest: (pathname: string, query?: Record<string, unknown>) => Promise<unknown>;
  declare _resolveSingleYouTubeTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSingleYouTubeTrackViaYtDlp: BivariantCallback<[string, (string | null | undefined)?], Promise<Track>>;
  declare _fetchSingleYouTubeTrackViaPlayDl: (url: string) => Promise<unknown>;
  declare _resolveYouTubePlaylistTracks: BivariantCallback<
    [string, (string | null | undefined)?, ({ fallbackWatchUrl?: string | null | undefined } | undefined)?],
    Promise<Track[]>
  >;
  declare _resolveYouTubePlaylistTracksViaYtDlp: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveYouTubePlaylistTracksViaPlayDl: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSingleUrlTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSoundCloudTrack: BivariantCallback<[string, (string | null | undefined)?], Promise<Track[]>>;
  declare _resolveSoundCloudPlaylist: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveSoundCloudPlaylistDirect: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveSoundCloudByGuess: BivariantCallback<[string, (string | null | undefined)?, (number | null | undefined)?], Promise<Track[]>>;
  declare _resolveCrossSourceToYouTube: BivariantCallback<[unknown[], string | null, string], Promise<Track[]>>;
  declare _resolveDirectHttpAudioTrack: (url: string, requestedBy: string | null) => Promise<Track | null>;
  declare _resolveRadioStreamTrack: (url: string, requestedBy: string | null, seen?: Set<string> | null) => Promise<Track | null>;
  declare _resolveFromUrlFallbackSearch: (url: string, requestedBy: string | null, source: string) => Promise<Track[]>;
  declare _normalizeInputUrl: (url: unknown) => Promise<string>;
  declare _getYtDlpClientStrategies: () => Array<boolean | string>;
  declare _withYtDlpProxyArgs: (args: string[], proxyUrl?: string | null) => string[];
  declare _runYtDlpCommandWithProxyFallback: (
    args: string[],
    timeoutMs?: number,
    options?: { context?: string | null }
  ) => Promise<{ stdout?: string | Buffer | null; stderr?: string | Buffer | null; code?: number | null }>;
  declare _resolveYtDlpStreamUrl: (
    url: string,
    formatSelector?: string | null,
    includeClientArg?: boolean | string | null,
    options?: { proxyUrl?: string | null }
  ) => Promise<string | null>;
  declare _startYtDlpPipeline: (
    url: string,
    seekSec?: number,
    options?: { proxyOnly?: boolean }
  ) => Promise<void>;
  declare _startYtDlpSeekPipeline: (
    url: string,
    seekSec?: number,
    formatSelector?: string | null,
    includeClientArg?: boolean | string | null
  ) => Promise<void>;
  declare _cloneTrack: (track: Track, overrides?: Partial<Track> & { id?: string; queuedAt?: number }) => Track;
  declare _trackKey: (track: Partial<Track> | null | undefined) => string | null;
  declare _hasDuplicateTrack: (candidate: Track) => boolean;
  declare _rememberTrack: (track: Track) => void;
  declare _parseDurationSeconds: (value: unknown) => number | null;
  declare _setPipelinePaused: (paused: boolean) => boolean;
  declare _createLiveAudioProcessor: () => LiveAudioProcessor;
  declare _createPlaybackOutputStream: () => PassThrough;
  declare _shouldUseLiveAudioProcessor: () => boolean;
  declare _awaitInitialPlaybackChunk: BivariantCallback<[NonNullable<PipelineProcess['stdout']>, PipelineProcess, number], Promise<void>>;
  declare _getInitialPlaybackChunkTimeoutMs: (track: Track, options?: { hint?: string | null }) => number;
  declare _startPlayDlPipeline: (url: string, seekSec?: number) => Promise<void>;
  declare _startHttpUrlPipeline: BivariantCallback<[string, number, ({ isLive?: boolean; proxyUrl?: string | null } | undefined)?], Promise<void>>;
  declare _startYouTubePipeline: (url: string, seekSec?: number) => Promise<void>;
  declare _probeHttpAudioTrack: (url: string, timeoutMs?: number) => Promise<{ durationSec: number | null; title: string | null; artist: string | null } | null>;
  voice: VoiceAdapterLike;
  queue: Queue<Track>;
  logger: LoggerLike | undefined;
  ffmpegBin: string;
  ytdlpBin: string | null;
  ytdlpCookiesFile: string | null;
  ytdlpSourceCookiesFile: string | null;
  ytdlpRuntimeCookiesFile: string | null;
  ytdlpCookiesFromBrowser: string | null;
  ytdlpYoutubeClient: string | null;
  ytdlpExtraArgs: string[];
  ytdlpProxyUrl: string | null;
  maxQueueSize: number;
  maxPlaylistTracks: number;
  minVolumePercent: number;
  maxVolumePercent: number;
  enableYtSearch: boolean;
  enableYtPlayback: boolean;
  enableSpotifyImport: boolean;
  enableDeezerImport: boolean;
  enableTidalImport: boolean;
  nodeLinkEnabled: boolean;
  nodeLinkRoutingMode: NodeLinkRoutingMode;
  nodeLinkClient: NodeLinkClient | null;
  spotifyClientId: string | null;
  spotifyClientSecret: string | null;
  spotifyRefreshToken: string | null;
  spotifyMarket: string;
  tidalToken: string | null;
  tidalCountryCode: string;
  appleMusicMediaApiToken: string | null;
  appleMusicAutoToken: boolean;
  appleMusicMarket: string;
  appleMusicTokenOrigin: string | null;
  _appleMusicMediaApiTokenExpiresAtMs: number;
  _appleMusicMediaApiTokenFetchedAtMs: number;
  deezerArl: string | null;
  _deezerCookieHeader: string | null;
  _deezerSessionTokens: unknown;
  _spotifyAccessToken: string | null;
  _spotifyAccessTokenExpiresAtMs: number;
  soundcloudClientId: string | null;
  soundcloudAutoClientId: boolean;
  youtubePlaylistResolver: string;
  enableYouTubePrefetchedPlayback: boolean;
  deezerTrackFormats: string[];
  filterPreset: string;
  eqPreset: string;
  tempoRatio: number;
  pitchSemitones: number;
  volumePercent: number;
  loopMode: string;
  ffmpeg: PipelineProcess | null;
  sourceProc: PipelineProcess | null;
  sourceStream: PipelineStreamLike | null;
  deezerDecryptStream: PipelineStreamLike | null;
  liveAudioProcessor: LiveAudioProcessor | null;
  playbackOutputStream: PassThrough | null;
  _deezerStreamMetaByTrackId: Map<unknown, unknown>;
  pipelineErrorHandlers: Array<unknown>;
  sources: Readonly<{
    audius: AudiusClient;
    deezer: DeezerClient;
    spotify: SpotifyClient;
    resolver: ResolverClient;
    soundcloud: SoundCloudClient;
  }>;
  playing: boolean;
  paused: boolean;
  skipRequested: boolean;
  pendingSeekTrack: Track | null;
  trackHistory: Track[];
  maxHistorySize: number;
  trackStartedAtMs: number | null;
  pauseStartedAtMs: number | null;
  totalPausedMs: number;
  currentTrackOffsetSec: number;
  lastKnownTrack: Track | null;
  lastKnownTrackAtMs: number;
  activePlaybackToken: number;
  playbackStartupToken: number;
  nextPlaybackStartupHint: string | null;
  nextTrackPrefetchToken: number;
  nextTrackPrefetchInFlightKey: string | null;
  nextTrackPrefetchPromise: Promise<void> | null;
  nextTrackPrefetchState: { key: string; streamUrl: string; proxyUrl: string | null; createdAtMs: number } | null;
  soundcloudClientIdResolvedAt: number;
  _lastYtDlpDiagnostics: Record<string, unknown> | null;
  _lastFfmpegArgs: string[] | null;
  normalizedInputUrlCache: Map<string, { url: string; expiresAtMs: number }>;
  consecutiveStartupFailures: number;
  activeSourceProcessCloseInfo: SourceProcessCloseInfo | null;

  constructor(voice: VoiceAdapterLike, options: MusicPlayerOptions = {}) {
    super();
    this.voice = voice;
    this.queue = new Queue();
    this.logger = options.logger ?? undefined;
    this.ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || String(ffmpegPath ?? '') || 'ffmpeg';
    this.ytdlpBin = options.ytdlpBin || process.env.YTDLP_BIN || null;
    this.ytdlpCookiesFile = options.ytdlpCookiesFile || process.env.YTDLP_COOKIES_FILE || null;
    this.ytdlpSourceCookiesFile = this.ytdlpCookiesFile;
    this.ytdlpRuntimeCookiesFile = null;
    this.ytdlpCookiesFromBrowser = options.ytdlpCookiesFromBrowser || process.env.YTDLP_COOKIES_FROM_BROWSER || null;
    const configuredYtdlpClient = options.ytdlpYoutubeClient ?? process.env.YTDLP_YOUTUBE_CLIENT ?? null;
    this.ytdlpYoutubeClient = String(configuredYtdlpClient ?? '').trim() || null;
    const configuredYtDlpExtraArgs = options.ytdlpExtraArgs ?? process.env.YTDLP_EXTRA_ARGS ?? null;
    const rawYtDlpExtraArgs = Array.isArray(configuredYtDlpExtraArgs)
      ? configuredYtDlpExtraArgs
      : parseCsvArgs(configuredYtDlpExtraArgs);
    this.ytdlpExtraArgs = normalizeYtDlpArgs(rawYtDlpExtraArgs);
    this.ytdlpProxyUrl = String(options.ytdlpProxyUrl ?? process.env.YTDLP_PROXY_URL ?? '').trim() || null;
    this._useRuntimeYtDlpCookiesFile();
    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.maxPlaylistTracks = options.maxPlaylistTracks ?? 25;
    this.minVolumePercent = options.minVolumePercent ?? 0;
    this.maxVolumePercent = options.maxVolumePercent ?? 200;
    this.enableYtSearch = options.enableYtSearch !== false;
    this.enableYtPlayback = options.enableYtPlayback !== false;
    this.enableSpotifyImport = options.enableSpotifyImport !== false;
    this.enableDeezerImport = options.enableDeezerImport !== false;
    this.enableTidalImport = options.enableTidalImport !== false;
    this.nodeLinkRoutingMode = normalizeNodeLinkRoutingMode(
      options.nodeLinkRoutingMode ?? process.env.NODELINK_ROUTING_MODE,
      'smart'
    );
    this.nodeLinkEnabled = options.nodeLinkEnabled ?? parseEnabledFlag(process.env.NODELINK_ENABLED, false);
    this.nodeLinkClient = this.nodeLinkEnabled
      ? new NodeLinkClient({
          baseUrl: options.nodeLinkBaseUrl ?? process.env.NODELINK_BASE_URL ?? null,
          password: options.nodeLinkPassword ?? process.env.NODELINK_PASSWORD ?? null,
          defaultSearchIdentifier: options.nodeLinkDefaultSearch ?? process.env.NODELINK_DEFAULT_SEARCH ?? null,
          requestTimeoutMs: options.nodeLinkRequestTimeoutMs ?? null,
          streamStartTimeoutMs: options.nodeLinkStreamStartTimeoutMs ?? null,
        })
      : null;
    this.spotifyClientId = String(options.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? '').trim() || null;
    this.spotifyClientSecret = String(options.spotifyClientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? '').trim() || null;
    this.spotifyRefreshToken = String(options.spotifyRefreshToken ?? process.env.SPOTIFY_REFRESH_TOKEN ?? '').trim() || null;
    this.spotifyMarket = String(options.spotifyMarket ?? process.env.SPOTIFY_MARKET ?? 'US').trim().toUpperCase() || 'US';
    this.tidalToken = String(options.tidalToken ?? process.env.TIDAL_TOKEN ?? '').trim() || null;
    this.tidalCountryCode = String(options.tidalCountryCode ?? process.env.TIDAL_COUNTRY_CODE ?? 'US').trim().toUpperCase() || 'US';
    this.appleMusicMediaApiToken = String(options.appleMusicMediaApiToken ?? process.env.APPLE_MUSIC_MEDIA_API_TOKEN ?? '').trim() || null;
    this.appleMusicAutoToken = options.appleMusicAutoToken ?? parseEnabledFlag(process.env.APPLE_MUSIC_AUTO_TOKEN, true);
    this.appleMusicMarket = String(options.appleMusicMarket ?? process.env.APPLE_MUSIC_MARKET ?? 'US').trim().toUpperCase() || 'US';
    this.appleMusicTokenOrigin = null;
    this._appleMusicMediaApiTokenExpiresAtMs = this.appleMusicMediaApiToken ? Number.MAX_SAFE_INTEGER : 0;
    this._appleMusicMediaApiTokenFetchedAtMs = this.appleMusicMediaApiToken ? Date.now() : 0;
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
    this.enableYouTubePrefetchedPlayback = parseEnabledFlag(
      options.enableYouTubePrefetchedPlayback ?? process.env.ENABLE_YOUTUBE_PREFETCHED_PLAYBACK,
      false
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
    this.playbackOutputStream = null;
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
    this.playbackStartupToken = 0;
    this.nextPlaybackStartupHint = null;
    this.nextTrackPrefetchToken = 0;
    this.nextTrackPrefetchInFlightKey = null;
    this.nextTrackPrefetchPromise = null;
    this.nextTrackPrefetchState = null;
    this.soundcloudClientIdResolvedAt = this.soundcloudClientId ? Date.now() : 0;

    this._lastYtDlpDiagnostics = null;
    this._lastFfmpegArgs = null;
    this.normalizedInputUrlCache = new Map();
    this.consecutiveStartupFailures = 0;
    this.activeSourceProcessCloseInfo = null;
  }

  _setNormalizedInputUrlCacheEntry(key: string, value: { url: string; expiresAtMs: number }): void {
    this._pruneExpiredNormalizedInputUrlCacheEntries();
    this.normalizedInputUrlCache.delete(key);
    this.normalizedInputUrlCache.set(key, value);
    while (this.normalizedInputUrlCache.size > NORMALIZED_INPUT_URL_CACHE_MAX_SIZE) {
      const oldest = this.normalizedInputUrlCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.normalizedInputUrlCache.delete(oldest);
    }
  }

  _pruneExpiredNormalizedInputUrlCacheEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.normalizedInputUrlCache.entries()) {
      if (entry.expiresAtMs <= now) {
        this.normalizedInputUrlCache.delete(key);
      }
    }
  }

  _setDeezerStreamMeta(trackId: string, meta: { url: string; cipherType: string; format: string | null }): void {
    this._deezerStreamMetaByTrackId.delete(trackId);
    this._deezerStreamMetaByTrackId.set(trackId, meta);
    while (this._deezerStreamMetaByTrackId.size > DEEZER_STREAM_META_CACHE_MAX_SIZE) {
      const oldest = this._deezerStreamMetaByTrackId.keys().next().value;
      if (!oldest) break;
      this._deezerStreamMetaByTrackId.delete(oldest);
    }
  }

  _getActiveYtDlpCookiesFile(): string | null {
    this._useRuntimeYtDlpCookiesFile();
    return this.ytdlpCookiesFile ? String(this.ytdlpCookiesFile).trim() || null : null;
  }

  _cleanupRuntimeYtDlpCookiesFile(): void {
    const runtimePath = String(this.ytdlpRuntimeCookiesFile ?? '').trim();
    this.ytdlpRuntimeCookiesFile = null;
    this.ytdlpCookiesFile = this.ytdlpSourceCookiesFile;

    if (!runtimePath) return;
    try {
      unlinkSync(runtimePath);
    } catch {}
  }

  _useRuntimeYtDlpCookiesFile(): void {
    if (!this.ytdlpCookiesFile || this.ytdlpCookiesFromBrowser) return;

    if (this.ytdlpRuntimeCookiesFile && existsSync(this.ytdlpRuntimeCookiesFile)) {
      this.ytdlpCookiesFile = this.ytdlpRuntimeCookiesFile;
      return;
    }

    const sourcePath = String(this.ytdlpSourceCookiesFile ?? this.ytdlpCookiesFile).trim();
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
      this._cleanupRuntimeYtDlpCookiesFile();
      copyFileSync(sourcePath, runtimePath);
      this.ytdlpCookiesFile = runtimePath;
      this.ytdlpRuntimeCookiesFile = runtimePath;
      this.logger?.info?.('Using runtime copy of yt-dlp cookies file to avoid mutating source cookies', {
        sourcePath,
        runtimePath,
      });
    } catch (err) {
      this.ytdlpRuntimeCookiesFile = null;
      this.ytdlpCookiesFile = sourcePath;
      this.logger?.warn?.('Failed to prepare runtime yt-dlp cookies file copy, using source file directly', {
        sourcePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get currentTrack(): Track | null {
    return this.queue.current;
  }

  get displayTrack(): Track | null {
    if (this.currentTrack) return this.currentTrack;
    const recentEnough = this.lastKnownTrackAtMs > 0 && (Date.now() - this.lastKnownTrackAtMs) <= 30_000;
    if (this.voice?.isStreaming && this.lastKnownTrack && recentEnough) {
      return this.lastKnownTrack;
    }
    return null;
  }

  get pendingTracks(): Track[] {
    return [...this.queue.tracks];
  }

  get historyTracks(): Track[] {
    return [...this.trackHistory];
  }

  async enqueue(query: string, options: EnqueueOptions = {}): Promise<Track[]> {
    const requestedBy = options.requestedBy ?? null;
    const playNext = Boolean(options.playNext);
    const dedupe = Boolean(options.dedupe);

    const tracks = await this._resolveTracks(query, requestedBy);
    if (!tracks.length) return [];

    return this.enqueueResolvedTracks(tracks, { dedupe, playNext });
  }

  enqueueResolvedTracks(tracks: Track[], options: EnqueueOptions = {}): Track[] {
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
        this.queue.addFront(filteredTracks[i]!);
      }
    } else {
      for (const track of filteredTracks) {
        this.queue.add(track);
      }
    }

    this.emit('tracksAdded', filteredTracks);
    this._scheduleNextTrackPrefetch();
    return filteredTracks;
  }

  _enforceQueueGuard(newTracks: Track[], guard: QueueGuardOption): void {
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

  _trackArtistKey(track: Partial<Track> | null | undefined): string | null {
    const explicit = String(track?.artist ?? '').trim().toLowerCase();
    if (explicit) return explicit;

    const title = String(track?.title ?? '').trim().toLowerCase();
    if (!title) return null;
    if (title.includes(' - ')) {
      return (title.split(' - ')[0] ?? '').trim() || null;
    }
    return title.split(' ').slice(0, 2).join(' ').trim();
  }

  async play(): Promise<void> {
    if (this.playing) return;

    this._cleanupProcesses();
    const startupHint = this.nextPlaybackStartupHint;
    this.nextPlaybackStartupHint = null;

    let track = this.queue.next();
    if (!track) {
      this._clearNextTrackPrefetch();
      this._cleanupRuntimeYtDlpCookiesFile();
      this._stopVoiceStream();
      this.emit('queueEmpty');
      return;
    }
    const playbackToken = ++this.activePlaybackToken;
    const startupToken = this._beginPlaybackStartup();

    this.playing = true;
    this.paused = false;
    this.skipRequested = false;
    let ffmpegStartupStderr = '';
    let onFfmpegStartupStderr = null;
    let ffmpegProc = null;
    let initialPlaybackChunkTimeoutMs: number | null = null;
    let retryStartupTrack: Track | null = null;
    this.activeSourceProcessCloseInfo = null;

    try {
      this._ensurePlaybackStartupActive(startupToken);
      let trackUrl = String(track.url ?? '').trim();
      if (!trackUrl) {
        throw new ValidationError('Track is missing a playable URL.');
      }

      if (track.nodelinkEncodedTrack) {
        try {
          await this._startNodeLinkStream(track, startupToken, playbackToken);
          return;
        } catch (nodeLinkErr) {
          if (this._isPlaybackStartupAbortedError(nodeLinkErr)) {
            throw nodeLinkErr;
          }

          this.logger?.warn?.('NodeLink stream startup failed, falling back to local playback pipeline', {
            title: track.title,
            source: track.source,
            url: trackUrl,
            error: nodeLinkErr instanceof Error ? nodeLinkErr.message : String(nodeLinkErr),
          });

          if (String(track.source ?? '').startsWith('spotify') || isSpotifyUrl(trackUrl)) {
            const requestedBy = String(track.requestedBy ?? '').trim() || null;
            const spotifyFallbackTracksResult = await this._resolveSpotifyMirror(track, requestedBy).catch((fallbackErr: unknown): Track[] => {
              this.logger?.warn?.('Spotify fallback resolution failed after NodeLink startup failure', {
                title: track.title,
                url: trackUrl,
                error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
              });
              return [];
            });
            const spotifyFallbackTracks = Array.isArray(spotifyFallbackTracksResult)
              ? spotifyFallbackTracksResult.filter((candidate): candidate is Track => Boolean(candidate && typeof candidate === 'object'))
              : [];
            const spotifyFallbackTrack = spotifyFallbackTracks[0] ?? null;
            if (spotifyFallbackTrack) {
              retryStartupTrack = this._cloneTrack(spotifyFallbackTrack, {
                seekStartSec: track.seekStartSec ?? 0,
              });
              (retryStartupTrack as Track & { startupRetryCount?: number }).startupRetryCount = 1;
              this.logger?.warn?.('Retrying Spotify playback after NodeLink startup failure', {
                title: track.title,
                url: trackUrl,
                fallbackSource: retryStartupTrack.source ?? null,
              });
              track = retryStartupTrack;
              trackUrl = String(track.url ?? '').trim() || trackUrl;
              this._cleanupProcesses();
            }
          }
          this._cleanupProcesses();
        }
      }

      if (isYouTubeUrl(trackUrl)) {
        const seekStartSec = Math.max(0, Number.parseInt(String(track.seekStartSec ?? 0), 10) || 0);
        const startupFallbackPipeline = getStartupFallbackPipeline(track);
        if (startupFallbackPipeline === 'ytdlp-url') {
          await this._startYtDlpSeekPipeline(trackUrl, seekStartSec);
        } else if (startupFallbackPipeline === 'ytdlp-proxy') {
          await this._startYtDlpPipeline(trackUrl, seekStartSec, { proxyOnly: true });
        } else {
          const shouldUsePrefetchedStreamUrl = seekStartSec <= 0 && (
            this.enableYouTubePrefetchedPlayback
            || String(startupHint ?? '').trim().toLowerCase() === 'skip'
          );
          const prefetchedStream = shouldUsePrefetchedStreamUrl
            ? this._consumeNextTrackPrefetch(track)
            : null;
          if (prefetchedStream) {
            this.logger?.debug?.('Using prefetched YouTube stream URL for playback startup', {
              title: track.title,
              url: trackUrl,
              startupHint: startupHint ?? null,
              proxyEnabled: Boolean(prefetchedStream.proxyUrl),
            });
            await this._startHttpUrlPipeline(prefetchedStream.streamUrl, 0, {
              isLive: false,
              proxyUrl: prefetchedStream.proxyUrl,
            });
          } else {
            await this._startYouTubePipeline(trackUrl, seekStartSec);
          }
        }
      } else if (track?.isLive || String(track.source ?? '').startsWith('radio')) {
        await this._startHttpUrlPipeline(trackUrl, 0, { isLive: true });
      } else if (String(track.source ?? '').startsWith('audius')) {
        await this.sources.audius.startPipeline(track, track.seekStartSec ?? 0);
      } else if (track?.deezerTrackId || String(track.source ?? '').startsWith('deezer-direct')) {
        await this.sources.deezer.startPipeline(track, track.seekStartSec ?? 0);
      } else if (String(track.source ?? '').startsWith('soundcloud')) {
        await this.sources.soundcloud.startPipeline(track, track.seekStartSec ?? 0);
      } else if (
        String(track.source ?? '') === 'http-audio'
        || (String(track.source ?? '') === 'url' && isHttpUrl(trackUrl))
      ) {
        await this._startHttpUrlPipeline(trackUrl, track.seekStartSec ?? 0, { isLive: false });
      } else {
        await this._startPlayDlPipeline(trackUrl, 0);
      }
      this._ensurePlaybackStartupActive(startupToken);

      ffmpegProc = this.ffmpeg;
      if (!ffmpegProc?.stdout?.pipe || !ffmpegProc?.once) {
        throw new Error('Playback pipeline did not initialize ffmpeg output.');
      }

      ffmpegProc.stderr?.setEncoding?.('utf8');
      onFfmpegStartupStderr = (chunk: unknown) => {
        ffmpegStartupStderr = `${ffmpegStartupStderr}${String(chunk ?? '')}`.slice(-4096);
      };
      ffmpegProc.stderr?.on?.('data', onFfmpegStartupStderr);

      let playbackStarted = false;
      ffmpegProc.once?.('close', async (code: unknown, signal: unknown) => {
        if (!playbackStarted) return;
        await this._handleTrackClose(track, code, signal, playbackToken);
      });

      const playbackOutput = this._createPlaybackOutputStream();
      if (this._shouldUseLiveAudioProcessor()) {
        this.liveAudioProcessor = this._createLiveAudioProcessor();
        this._bindPipelineErrorHandler(this.liveAudioProcessor, 'liveAudioProcessor');
        ffmpegProc.stdout?.pipe?.(this.liveAudioProcessor);
        this.liveAudioProcessor.pipe(playbackOutput);
      } else {
        ffmpegProc.stdout?.pipe?.(playbackOutput);
      }

      await this.voice.sendAudio?.(playbackOutput);
      this._ensurePlaybackStartupActive(startupToken);
      initialPlaybackChunkTimeoutMs = this._getInitialPlaybackChunkTimeoutMs(track, { hint: startupHint });
      await this._awaitInitialPlaybackChunk(
        playbackOutput,
        ffmpegProc,
        initialPlaybackChunkTimeoutMs
      );
      this._ensurePlaybackStartupActive(startupToken);
      playbackStarted = true;
      this.consecutiveStartupFailures = 0;
      this.activeSourceProcessCloseInfo = null;
      this._startPlaybackClock(track.seekStartSec ?? 0);
      this.lastKnownTrack = track;
      this.lastKnownTrackAtMs = Date.now();
      this._scheduleNextTrackPrefetch();
      this.emit('trackStart', track);
      this.logger?.info?.('Playback started', {
        title: track.title,
        url: track.url,
        seek: track.seekStartSec ?? 0,
        guildId: String((this.voice as { guildId?: unknown } | null | undefined)?.guildId ?? '').trim() || null,
        channelId: String((this.voice as { channelId?: unknown } | null | undefined)?.channelId ?? '').trim() || null,
      });
    } catch (err) {
      const startupAborted = this._isPlaybackStartupAbortedError(err);
      let normalizedMessage = '';
      if (!startupAborted) {
        const normalized = this._normalizePlaybackError(this._withStartupStderr(err, ffmpegStartupStderr));
        normalizedMessage = String(normalized?.message ?? '').toLowerCase();
        const startupRetryAttempt = getStartupRetryAttempt(track);
        const shouldFallbackToYtDlpUrl = (
          normalizedMessage.includes('before audio output')
          && String(track?.source ?? '').startsWith('youtube')
          && startupRetryAttempt < 1
        );
        const shouldRetryYouTubeStartup = (
          normalizedMessage.includes('did not produce audio output in time')
          && String(track?.source ?? '').startsWith('youtube')
          && startupRetryAttempt < 1
        ) || shouldFallbackToYtDlpUrl;
        if (shouldRetryYouTubeStartup) {
          retryStartupTrack = this._cloneTrack(track, { seekStartSec: track?.seekStartSec ?? 0 });
          (retryStartupTrack as Track & { startupRetryCount?: number }).startupRetryCount = startupRetryAttempt + 1;
          if (!String(retryStartupTrack.nodelinkEncodedTrack ?? '').trim()) {
            const nodeLinkRetryTrack = await this._resolveYouTubeTrackViaNodeLink(retryStartupTrack).catch((nodeLinkErr: unknown) => {
              this.logger?.debug?.('NodeLink retry preparation failed, continuing with local YouTube startup fallback', {
                title: track?.title ?? null,
                url: track?.url ?? null,
                error: nodeLinkErr instanceof Error ? nodeLinkErr.message : String(nodeLinkErr),
              });
              return null;
            });
            if (nodeLinkRetryTrack) {
              retryStartupTrack = this._cloneTrack(nodeLinkRetryTrack, {
                seekStartSec: track?.seekStartSec ?? 0,
              });
              (retryStartupTrack as Track & { startupRetryCount?: number }).startupRetryCount = startupRetryAttempt + 1;
            }
          }
          const currentYtDlpDiagnostics = this._lastYtDlpDiagnostics;
          const shouldRetryWithProxyPipe = (
            !String(retryStartupTrack.nodelinkEncodedTrack ?? '').trim()
            && Boolean(this.ytdlpProxyUrl)
            && !currentYtDlpDiagnostics?.proxyEnabled
          );
          if (shouldRetryWithProxyPipe) {
            (retryStartupTrack as Track & { startupFallbackPipeline?: 'ytdlp-proxy' }).startupFallbackPipeline = 'ytdlp-proxy';
          } else if (!String(retryStartupTrack.nodelinkEncodedTrack ?? '').trim() && shouldFallbackToYtDlpUrl) {
            (retryStartupTrack as Track & { startupFallbackPipeline?: 'ytdlp-url' }).startupFallbackPipeline = 'ytdlp-url';
          }
        }
        const setupFailureLogPayload = {
          track: track.title,
          url: track?.url ?? null,
          source: track?.source ?? null,
          seek: track?.seekStartSec ?? 0,
          startupHint: startupHint ?? null,
          initialPlaybackChunkTimeoutMs: typeof initialPlaybackChunkTimeoutMs === 'number'
            ? initialPlaybackChunkTimeoutMs
            : null,
          error: normalized.message,
        };
        if (retryStartupTrack) {
          this.logger?.warn?.('Playback setup failed before audio output; retrying startup', setupFailureLogPayload);
        } else {
          this.emit('trackError', { track, error: normalized });
          this.logger?.error?.('Playback setup failed', setupFailureLogPayload);
        }
        const isStartupFloodCandidate = (
          normalizedMessage.includes('did not produce audio output in time')
          || normalizedMessage.includes('before audio output')
        );
        if (isStartupFloodCandidate) {
          const playerDiagnostics = typeof this.getDiagnostics === 'function'
            ? this.getDiagnostics()
            : null;
          const voiceDiagnostics = typeof this.voice?.getDiagnostics === 'function'
            ? await this.voice.getDiagnostics().catch(() => null)
            : {
                connected: Boolean(this.voice?.connected),
                isStreaming: Boolean(this.voice?.isStreaming),
                channelId: (this.voice as { channelId?: unknown } | null | undefined)?.channelId ?? null,
              };
          this.logger?.warn?.('Playback startup diagnostics snapshot', {
            track: track.title,
            url: track?.url ?? null,
            source: track?.source ?? null,
            seek: track?.seekStartSec ?? 0,
            startupHint: startupHint ?? null,
            initialPlaybackChunkTimeoutMs,
            player: playerDiagnostics,
            voice: voiceDiagnostics,
          });
        }
        this.consecutiveStartupFailures = retryStartupTrack
          ? 0
          : isStartupFloodCandidate
          ? this.consecutiveStartupFailures + 1
          : 0;
        if (retryStartupTrack) {
          this.logger?.warn?.('Retrying YouTube startup after pre-audio pipeline failure', {
            title: track?.title ?? null,
            url: track?.url ?? null,
            source: track?.source ?? null,
            seek: track?.seekStartSec ?? 0,
            retryAttempt: (retryStartupTrack as Track & { startupRetryCount?: number }).startupRetryCount ?? 1,
            fallbackPipeline: getStartupFallbackPipeline(retryStartupTrack),
            previousStartupHint: startupHint ?? null,
            previousInitialPlaybackChunkTimeoutMs: initialPlaybackChunkTimeoutMs,
          });
        }
      } else {
        this.logger?.debug?.('Playback startup aborted before first audio chunk', {
          title: track?.title ?? null,
          url: track?.url ?? null,
        });
      }

      const pendingSeekTrack = this.pendingSeekTrack;
      this.pendingSeekTrack = null;

      this._cleanupProcesses();
      this.playing = false;
      this.paused = false;
      this._resetPlaybackClock();
      this.queue.current = null;

      if (startupAborted && pendingSeekTrack) {
        this.queue.addFront(pendingSeekTrack);
      }

      if (retryStartupTrack) {
        this.queue.addFront(retryStartupTrack);
      }

      if (
        !startupAborted
        && this.queue.pendingSize > 0
        && this.consecutiveStartupFailures >= STARTUP_FAILURE_STREAK_LIMIT
      ) {
        const droppedTracks = this.clearQueue();
        this._cleanupRuntimeYtDlpCookiesFile();
        this._stopVoiceStream();
        this.logger?.warn?.('Halting queue after repeated playback startup failures', {
          failedTrack: track?.title ?? null,
          consecutiveStartupFailures: this.consecutiveStartupFailures,
          droppedTracks,
        });
        this.emit('queueEmpty', {
          reason: 'startup_error_limit',
          consecutiveStartupFailures: this.consecutiveStartupFailures,
          droppedTracks,
        });
        return;
      }

      if (this.queue.pendingSize > 0) {
        await this.play();
        return;
      }

      this._clearNextTrackPrefetch();
      this._cleanupRuntimeYtDlpCookiesFile();
      this._stopVoiceStream();
      if (!startupAborted) {
        this.emit('queueEmpty', { reason: 'startup_error' });
        return;
      }

      if (this.skipRequested || pendingSeekTrack) {
        this.emit('queueEmpty');
      }
    } finally {
      if (onFfmpegStartupStderr) {
        ffmpegProc?.stderr?.off?.('data', onFfmpegStartupStderr);
      }
    }
  }

  _cleanupProcesses() {
    cleanupProcesses(this);
  }

  _beginPlaybackStartup(): number {
    this.playbackStartupToken += 1;
    return this.playbackStartupToken;
  }

  _invalidatePlaybackStartup(): void {
    this.playbackStartupToken += 1;
  }

  _ensurePlaybackStartupActive(token: number): void {
    if (token !== this.playbackStartupToken) {
      throw new PlaybackStartupAbortedError();
    }
  }

  _isPlaybackStartupAbortedError(err: unknown): boolean {
    return err instanceof PlaybackStartupAbortedError;
  }

  _withStartupStderr(err: unknown, stderrText = ''): unknown {
    if (!(err instanceof Error)) return err;
    const trimmed = String(stderrText ?? '').trim();
    if (!trimmed) return err;
    if (!String(err.message ?? '').includes('Playback pipeline exited before audio output')) {
      return err;
    }

    const tail = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' | ');
    if (!tail) return err;
    return new Error(`${err.message} ${tail}`);
  }

  _getTrackPrefetchKey(track: Track | null | undefined): string | null {
    if (!track) return null;
    const id = String(track.id ?? '').trim();
    return id || this._trackKey(track);
  }

  _canPrefetchTrack(track: Track | null | undefined): boolean {
    if (!track || track.isLive) return false;
    if (String(track.nodelinkEncodedTrack ?? '').trim()) return false;
    const url = String(track.url ?? '').trim();
    if (!url || !isYouTubeUrl(url) || !this.enableYtPlayback) return false;
    const seekStartSec = Math.max(0, Number.parseInt(String(track.seekStartSec ?? 0), 10) || 0);
    return seekStartSec <= 0;
  }

  async _prefetchYouTubeStreamUrl(url: string): Promise<YouTubePrefetchedStream | null> {
    const formats = ['bestaudio/best', null];
    const strategies = this._getYtDlpClientStrategies?.() ?? [false];
    const proxyUrl = String(this.ytdlpProxyUrl ?? '').trim() || null;

    for (const formatSelector of formats) {
      for (const includeClientArg of strategies) {
        try {
          const streamUrl = await this._resolveYtDlpStreamUrl(url, formatSelector, includeClientArg);
          if (streamUrl) return { streamUrl, proxyUrl: null };
        } catch (err) {
          this.logger?.debug?.('Next-track YouTube prefetch strategy failed', {
            url,
            formatSelector: formatSelector ?? '(default)',
            includeClientArg,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!proxyUrl) continue;

        try {
          const streamUrl = await this._resolveYtDlpStreamUrl(url, formatSelector, includeClientArg, { proxyUrl });
          if (streamUrl) return { streamUrl, proxyUrl };
        } catch (err) {
          this.logger?.debug?.('Next-track YouTube proxy prefetch strategy failed', {
            url,
            formatSelector: formatSelector ?? '(default)',
            includeClientArg,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return null;
  }

  _clearNextTrackPrefetch(): void {
    this.nextTrackPrefetchToken += 1;
    this.nextTrackPrefetchInFlightKey = null;
    this.nextTrackPrefetchPromise = null;
    this.nextTrackPrefetchState = null;
  }

  _consumeNextTrackPrefetch(track: Track | null | undefined): YouTubePrefetchedStream | null {
    const key = this._getTrackPrefetchKey(track);
    if (!key || this.nextTrackPrefetchState?.key !== key) return null;

    if ((Date.now() - this.nextTrackPrefetchState.createdAtMs) > NEXT_TRACK_PREFETCH_TTL_MS) {
      this.nextTrackPrefetchState = null;
      return null;
    }

    const prefetchedStream = {
      streamUrl: this.nextTrackPrefetchState.streamUrl,
      proxyUrl: this.nextTrackPrefetchState.proxyUrl,
    };
    this.nextTrackPrefetchState = null;
    return prefetchedStream;
  }

  _scheduleNextTrackPrefetch(): void {
    const nextTrack = this.pendingTracks[0] ?? null;
    if (!this._canPrefetchTrack(nextTrack)) {
      this._clearNextTrackPrefetch();
      return;
    }

    const key = this._getTrackPrefetchKey(nextTrack);
    const url = String(nextTrack?.url ?? '').trim();
    if (!key || !url) {
      this._clearNextTrackPrefetch();
      return;
    }

    if (this.nextTrackPrefetchState?.key === key) {
      if ((Date.now() - this.nextTrackPrefetchState.createdAtMs) <= NEXT_TRACK_PREFETCH_TTL_MS) {
        return;
      }
      this.nextTrackPrefetchState = null;
    }

    if (this.nextTrackPrefetchInFlightKey === key) {
      return;
    }

    if (this.nextTrackPrefetchInFlightKey && this.nextTrackPrefetchInFlightKey !== key) {
      this._clearNextTrackPrefetch();
    }

    const token = ++this.nextTrackPrefetchToken;
    this.nextTrackPrefetchInFlightKey = key;
    this.nextTrackPrefetchPromise = (async () => {
      const prefetchedStream = await this._prefetchYouTubeStreamUrl(url);
      if (!prefetchedStream || token !== this.nextTrackPrefetchToken) return;

      const activeNextTrack = this.pendingTracks[0] ?? null;
      if (this._getTrackPrefetchKey(activeNextTrack) !== key) return;

      this.nextTrackPrefetchState = {
        key,
        streamUrl: prefetchedStream.streamUrl,
        proxyUrl: prefetchedStream.proxyUrl,
        createdAtMs: Date.now(),
      };
      this.logger?.debug?.('Prefetched next YouTube track stream URL', {
        title: activeNextTrack?.title ?? null,
        url,
        proxyEnabled: Boolean(prefetchedStream.proxyUrl),
      });
    })()
      .catch((err: unknown) => {
        if (token !== this.nextTrackPrefetchToken) return;
        this.logger?.debug?.('Next-track YouTube prefetch failed', {
          title: nextTrack?.title ?? null,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (token !== this.nextTrackPrefetchToken) return;
        this.nextTrackPrefetchInFlightKey = null;
        this.nextTrackPrefetchPromise = null;
      });
  }

  async prefetchTrackPlayback(track: Track | null | undefined): Promise<void> {
    if (!this.enableYouTubePrefetchedPlayback) {
      this._clearNextTrackPrefetch();
      return;
    }

    if (!this._canPrefetchTrack(track)) return;

    const key = this._getTrackPrefetchKey(track);
    const url = String(track?.url ?? '').trim();
    if (!key || !url) return;

    if (
      this.nextTrackPrefetchState?.key === key
      && (Date.now() - this.nextTrackPrefetchState.createdAtMs) <= NEXT_TRACK_PREFETCH_TTL_MS
    ) {
      return;
    }

    const token = ++this.nextTrackPrefetchToken;
    this.nextTrackPrefetchInFlightKey = key;
    this.nextTrackPrefetchPromise = (async () => {
      const prefetchedStream = await this._prefetchYouTubeStreamUrl(url);
      if (!prefetchedStream || token !== this.nextTrackPrefetchToken) return;
      if (this._getTrackPrefetchKey(track) !== key) return;

      this.nextTrackPrefetchState = {
        key,
        streamUrl: prefetchedStream.streamUrl,
        proxyUrl: prefetchedStream.proxyUrl,
        createdAtMs: Date.now(),
      };
      this.logger?.debug?.('Prefetched YouTube track stream URL for immediate playback', {
        title: track?.title ?? null,
        url,
        proxyEnabled: Boolean(prefetchedStream.proxyUrl),
      });
    })()
      .catch((err: unknown) => {
        if (token !== this.nextTrackPrefetchToken) return;
        this.logger?.debug?.('Immediate YouTube track prefetch failed', {
          title: track?.title ?? null,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (token !== this.nextTrackPrefetchToken) return;
        this.nextTrackPrefetchInFlightKey = null;
        this.nextTrackPrefetchPromise = null;
      });

    await this.nextTrackPrefetchPromise;
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

  _bindPipelineErrorHandler(stream: unknown, label: string) {
    bindPipelineErrorHandler(this, stream, label);
  }

  _isExpectedPipeError(err: unknown) {
    return isExpectedPipeError(err);
  }

  async _startNodeLinkStream(track: Track, startupToken: number, playbackToken: number): Promise<void> {
    if (!this.nodeLinkClient?.enabled) {
      throw new ValidationError('NodeLink is not configured.');
    }

    const positionMs = Math.max(0, Number.parseInt(String(track.seekStartSec ?? 0), 10) || 0) * 1000;
    const guildId = String((this.voice as { guildId?: unknown } | null | undefined)?.guildId ?? '').trim() || null;
    const nodeLinkStream = await this.nodeLinkClient.streamTrack(track, {
      positionMs,
      volume: 100,
      ...(guildId ? { guildId } : {}),
    });
    this.sourceStream = nodeLinkStream as PipelineStreamLike;
    this._bindPipelineErrorHandler(nodeLinkStream, 'nodelink.stream');

    let playbackStarted = false;
    let closeHandled = false;
    const onClose = async () => {
      if (!playbackStarted || closeHandled) return;
      closeHandled = true;
      await this._handleTrackClose(track, 0, null, playbackToken);
    };
    nodeLinkStream.once('end', onClose);
    nodeLinkStream.once('close', onClose);

    const playbackOutput = this._createPlaybackOutputStream();
    if (this._shouldUseLiveAudioProcessor()) {
      this.liveAudioProcessor = this._createLiveAudioProcessor();
      this._bindPipelineErrorHandler(this.liveAudioProcessor, 'liveAudioProcessor');
      nodeLinkStream.pipe(this.liveAudioProcessor);
      this.liveAudioProcessor.pipe(playbackOutput);
    } else {
      nodeLinkStream.pipe(playbackOutput);
    }

    await this.voice.sendAudio?.(playbackOutput);
    this._ensurePlaybackStartupActive(startupToken);
    const timeoutMs = this._getInitialPlaybackChunkTimeoutMs(track, { hint: 'nodelink' });
    await this._awaitInitialPlaybackChunk(playbackOutput, nodeLinkStream as unknown as PipelineProcess, timeoutMs);
    this._ensurePlaybackStartupActive(startupToken);
    playbackStarted = true;
    this.consecutiveStartupFailures = 0;
    this.activeSourceProcessCloseInfo = null;
    this._startPlaybackClock(track.seekStartSec ?? 0);
    this.lastKnownTrack = track;
    this.lastKnownTrackAtMs = Date.now();
    this._scheduleNextTrackPrefetch();
    this.emit('trackStart', track);
    this.logger?.info?.('Playback started', {
      title: track.title,
      url: track.url,
      source: track.source,
      backend: 'nodelink',
      seek: track.seekStartSec ?? 0,
      guildId,
      channelId: String((this.voice as { channelId?: unknown } | null | undefined)?.channelId ?? '').trim() || null,
    });
  }

  _startPlaybackClock(offsetSec: number) {
    startPlaybackClock(this, offsetSec);
  }

  _resetPlaybackClock() {
    resetPlaybackClock(this);
  }

  _normalizePlaybackError(err: unknown) {
    return normalizePlaybackError(this, err);
  }
}

Object.assign(
  MusicPlayer.prototype,
  playbackStateMethods,
  queueLifecycleMethods,
  resolverMethods,
  nodeLinkMethods,
  trackRuntimeMethods,
  pipelineMethods,
  sourceMethods
);





