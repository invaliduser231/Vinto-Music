import playdl from 'play-dl';
import type { InfoData, YouTubePlayList } from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import { isPlayDlBrowseFailure } from './errorUtils.ts';
import type { Track, TrackInput } from '../../types/domain.ts';
import {
  inferYouTubeWatchUrlFromPlaylist,
  isAudiomackUrl,
  isAmazonMusicUrl,
  isAppleMusicUrl,
  isAudiusUrl,
  isBandcampUrl,
  isDeezerUrl,
  isHttpUrl,
  isJioSaavnUrl,
  isLikelyDirectAudioFileUrl,
  isLikelyPlaylistUrl,
  isMixcloudUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isTidalUrl,
  isYouTubeUrl,
  normalizeYouTubeVideoUrlFromEntry,
  pickThumbnailUrlFromItem,
  pickTrackArtistFromMetadata,
  toCanonicalYouTubePlaylistUrl,
  toCanonicalYouTubeWatchUrl,
} from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import { asRecord, isRecord, isUnknownArray, type UnknownRecord } from '../../utils/unknownData.ts';

type ResolverDiagnostics = {
  playing: boolean;
  paused: boolean;
  skipRequested: boolean;
  loopMode: string;
  progressSec: number;
  volumePercent: number;
  filterPreset: string;
  eqPreset: string;
  tempoRatio: number;
  pitchSemitones: number;
  deezerTrackFormats: string[];
  pendingCount: number;
  hasCurrentTrack: boolean;
  sourceProcPid: number | null;
  ffmpegPid: number | null;
  ffmpegArgs: string[] | null;
  ytdlp: UnknownRecord | null;
  nodeLink: UnknownRecord;
};

type YouTubePlaylistResolveOptions = {
  fallbackWatchUrl?: string | null;
  limit?: number | null;
};

export interface ResolverMethodMembers {
  _resolveYouTubeTrackViaNodeLink(track: Partial<Track> | null | undefined): Promise<Track | null>;
  _resolveStartupMirrorFallbackTrack(
    track: Partial<Track> | null | undefined,
    requestedBy: string | null,
    exhaustedSources?: readonly string[],
  ): Promise<Track | null>;
  _shouldUseDirectDeezerMirror(): boolean;
  _isNodeLinkOnlyModeForSourceTrack(track: Partial<Track> | null | undefined, trackUrl?: string | null): boolean;
  _resolveTracks(query: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveTracksFromSource(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveSearchTrack(query: string, requestedBy: string | null): Promise<Track[]>;
  getDiagnostics(): ResolverDiagnostics;
  searchCandidates(query: string, limit?: number, options?: { requestedBy?: string | null }): Promise<Track[]>;
  _searchYouTubeTracks(query: string, limit: number, requestedBy: string | null): Promise<Track[]>;
  _searchDeezerTracks(query: string, limit: number, requestedBy: string | null): Promise<Track[]>;
  previewTracks(query: string, options?: { requestedBy?: string | null; limit?: number }): Promise<Track[]>;
  createTrackFromData(data: TrackInput, requestedBy?: string | null): Track;
  hydrateTrackMetadata(data: TrackInput, options?: { requestedBy?: string | null }): Promise<Track | null>;
  _resolveSingleYouTubeTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _fetchSingleYouTubeTrackViaPlayDl(url: string): Promise<InfoData>;
  _resolveSingleYouTubeTrackViaYtDlp(url: string, requestedBy: string | null): Promise<Track>;
  _resolveYouTubePlaylistTracks(
    url: string,
    requestedBy: string | null,
    options?: YouTubePlaylistResolveOptions,
  ): Promise<Track[]>;
  _fetchYouTubePlaylistInfo(url: string): Promise<YouTubePlayList>;
  _resolveYouTubePlaylistTracksViaPlayDl(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveYouTubePlaylistTracksViaYtDlp(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
}

const MIRROR_TOTAL_BUDGET_MS = 20_000;

const MIRROR_SEARCH_SOURCES: Record<string, string> = {
  dzsearch: 'deezer',
  tdsearch: 'tidal',
  scsearch: 'soundcloud',
  ytsearch: 'youtube',
  ytmsearch: 'youtube',
  amsearch: 'applemusic',
  jssearch: 'jiosaavn',
};

function toText(value: unknown): string {
  return value ? String(value) : '';
}

function toOptionalText(value: unknown): string | null {
  return value ? String(value) : null;
}

function toNullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toDurationValue(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return String(value);
}

function toSeekStartValue(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number.parseInt(String(value), 10) || 0;
}

function readPlaylistVideos(playlist: object): unknown {
  return 'videos' in playlist ? playlist.videos : undefined;
}

function normalizeResolveLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

function isYouTubeWatchContextMixUrl(url: string | null | undefined) {
  const normalized = String(url ?? '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('/watch?') && (normalized.includes('start_radio=1') || normalized.includes('list=rd'));
}

function getNodeLinkRoutingMode(value: unknown): 'smart' | 'all' | 'youtube-only' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'all') return 'all';
  if (normalized === 'youtube-only' || normalized === 'youtube') return 'youtube-only';
  return 'smart';
}

function requiresNodeLinkResolution(url: string) {
  return (
    isSpotifyUrl(url)
    || isTidalUrl(url)
    || isAppleMusicUrl(url)
    || isAmazonMusicUrl(url)
    || isBandcampUrl(url)
    || isAudiomackUrl(url)
    || isMixcloudUrl(url)
    || isJioSaavnUrl(url)
  );
}

function shouldBypassNodeLinkForDirectStreamUrl(
  url: string,
  routingMode: 'smart' | 'all' | 'youtube-only',
) {
  if (routingMode !== 'all') return false;
  if (isYouTubeUrl(url)) return false;
  if (
    !isSoundCloudUrl(url)
    && !isSpotifyUrl(url)
    && !isDeezerUrl(url)
    && !isTidalUrl(url)
    && !isBandcampUrl(url)
    && !isAudiomackUrl(url)
    && !isMixcloudUrl(url)
    && !isJioSaavnUrl(url)
    && !isAmazonMusicUrl(url)
    && !isAppleMusicUrl(url)
    && !isAudiusUrl(url)
  ) {
    return true;
  }
  return isLikelyDirectAudioFileUrl(url) || isLikelyPlaylistUrl(url);
}

export function shouldMirrorFailedStartup(options: {
  url?: string | null;
  source?: string | null;
  isLive?: boolean | null;
  previousMirrorSources?: readonly string[] | null;
  nodeLinkOnly?: boolean | null;
}): boolean {
  const source = String(options.source ?? '').toLowerCase();
  if (options.isLive) return false;
  if (source.startsWith('radio')) return false;
  if (source === 'http-audio' || source === 'url') return false;

  const alreadyMirrored = (options.previousMirrorSources?.length ?? 0) > 0;
  if (isYouTubeUrl(String(options.url ?? '')) && !alreadyMirrored && !options.nodeLinkOnly) return false;

  return true;
}

export const resolverMethods: ResolverMethodMembers & ThisType<MusicPlayer> = {
  async _resolveYouTubeTrackViaNodeLink(track: Partial<Track> | null | undefined) {
    const url = String(track?.url ?? '').trim();
    if (!url || !isYouTubeUrl(url)) return null;
    if (!this.nodeLinkEnabled || !this.nodeLinkClient?.enabled) return null;

    const nodeLinkRoutingMode = getNodeLinkRoutingMode(this.nodeLinkRoutingMode);
    const shouldBypassNodeLink = shouldBypassNodeLinkForDirectStreamUrl(url, nodeLinkRoutingMode);
    const shouldTryNodeLinkForUrl = !shouldBypassNodeLink && (nodeLinkRoutingMode === 'all' || isYouTubeUrl(url));
    if (!shouldTryNodeLinkForUrl) return null;

    const requestedBy = track?.requestedBy ?? null;
    const nodeLinkResolved = await this._resolveNodeLinkTracks(url, requestedBy, 1).catch((err: unknown) => {
      if (nodeLinkRoutingMode === 'all') {
        throw err;
      }
      this.logger?.debug?.('NodeLink YouTube track resolution failed, keeping local fallback path available', {
        url,
        routingMode: nodeLinkRoutingMode,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    return Array.isArray(nodeLinkResolved) ? (nodeLinkResolved[0] ?? null) : null;
  },

  async _resolveStartupMirrorFallbackTrack(
    track: Partial<Track> | null | undefined,
    requestedBy: string | null,
    exhaustedSources: readonly string[] = [],
  ) {
    const title = String(track?.title ?? '').trim();
    if (!title) return null;

    const artist = String(track?.artist ?? '').trim();
    const query = artist ? `${artist} - ${title}` : title;
    const blocked = new Set(
      [String(track?.source ?? ''), ...exhaustedSources]
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
    );

    if (this.nodeLinkEnabled && this.nodeLinkClient?.enabled) {
      const order = Array.isArray(this.nodeLinkMirrorSearchOrder) && this.nodeLinkMirrorSearchOrder.length
        ? this.nodeLinkMirrorSearchOrder
        : ['dzsearch', 'tdsearch', 'scsearch', 'ytsearch', 'ytmsearch'];

      const deadline = Date.now() + MIRROR_TOTAL_BUDGET_MS;

      for (const searchIdentifier of order) {
        const identifierSource = MIRROR_SEARCH_SOURCES[searchIdentifier];
        if (identifierSource && blocked.has(identifierSource)) continue;
        if (identifierSource === 'youtube' && (!this.enableYtSearch || !this.enableYtPlayback)) continue;
        if (identifierSource && this._isMirrorSourceCooling?.(identifierSource)) continue;
        if (Date.now() >= deadline) {
          this.logger?.debug?.('Mirror search budget exhausted', {
            query,
            skippedFrom: searchIdentifier,
          });
          break;
        }

        const nodeLinkMatches = await this._resolveNodeLinkTracks(query, requestedBy, 1, { searchIdentifier })
          .catch((err: unknown) => {
            this.logger?.debug?.('NodeLink mirror search failed', {
              query,
              searchIdentifier,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          });
        const match = Array.isArray(nodeLinkMatches) ? (nodeLinkMatches[0] ?? null) : null;
        if (!match) continue;
        if (blocked.has(String(match.source ?? '').trim().toLowerCase())) continue;
        return match;
      }
    }

    if (!this.enableYtSearch || !this.enableYtPlayback || blocked.has('youtube')) return null;
    if (this.nodeLinkEnabled && this.nodeLinkClient?.enabled && getNodeLinkRoutingMode(this.nodeLinkRoutingMode) === 'all') {
      return null;
    }

    const localMatches = await this._searchYouTubeTracks(query, 1, requestedBy).catch((err: unknown) => {
      this.logger?.debug?.('Local YouTube mirror search failed', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });
    return Array.isArray(localMatches) ? (localMatches[0] ?? null) : null;
  },

  _shouldUseDirectDeezerMirror() {
    if (!this.deezerArl || !this.enableDeezerImport) return false;
    if (!this.nodeLinkEnabled || !this.nodeLinkClient?.enabled) return true;
    return getNodeLinkRoutingMode(this.nodeLinkRoutingMode) !== 'all';
  },

  _isNodeLinkOnlyModeForSourceTrack(track: Partial<Track> | null | undefined, trackUrl?: string | null) {
    if (!this.nodeLinkEnabled || !this.nodeLinkClient?.enabled) return false;
    if (getNodeLinkRoutingMode(this.nodeLinkRoutingMode) !== 'all') return false;

    const url = String(trackUrl ?? track?.url ?? '');
    if (isYouTubeUrl(url)) return true;
    if (track?.isLive) return false;

    const source = String(track?.source ?? '').toLowerCase();
    if (source.startsWith('radio')) return false;
    if (source === 'http-audio' || source === 'url') return false;

    return true;
  },

  async _resolveTracks(query: string, requestedBy: string | null, limit?: number | null) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      throw new ValidationError('Missing query.');
    }

    const safeLimit = normalizeResolveLimit(limit, this.maxPlaylistTracks);
    const nodeLinkRoutingMode = getNodeLinkRoutingMode(this.nodeLinkRoutingMode);
    if (!isHttpUrl(raw)) {
      return this._resolveSearchTrack(raw, requestedBy);
    }

    const url = await this.sources.resolver.normalizeInputUrl(raw);
    const nodeLinkAvailable = Boolean(this.nodeLinkEnabled && this.nodeLinkClient?.enabled);
    const nodeLinkOnly = requiresNodeLinkResolution(url);
    const shouldBypassNodeLink = !nodeLinkOnly && shouldBypassNodeLinkForDirectStreamUrl(url, nodeLinkRoutingMode);
    const shouldTryNodeLinkForUrl = !shouldBypassNodeLink
      && (nodeLinkOnly || nodeLinkRoutingMode === 'all' || isYouTubeUrl(url));

    if (nodeLinkOnly && !nodeLinkAvailable) {
      throw new ValidationError(
        `Links from this service are resolved by NodeLink, which is not available. Enable NodeLink to play ${url}.`
      );
    }

    if (nodeLinkAvailable && shouldTryNodeLinkForUrl) {
      const strictNodeLink = nodeLinkOnly || nodeLinkRoutingMode === 'all';
      const nodeLinkResolved = await this._resolveNodeLinkTracks(url, requestedBy, safeLimit, { urlQuery: true }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (strictNodeLink) {
          throw new ValidationError(`NodeLink could not resolve ${url}. It reported: ${reason}`);
        }
        this.logger?.debug?.('NodeLink URL resolution failed, falling back to local resolver path', {
          url,
          routingMode: nodeLinkRoutingMode,
          error: reason,
        });
        return null;
      });
      if (Array.isArray(nodeLinkResolved) && nodeLinkResolved.length > 0) {
        return nodeLinkResolved;
      }
      if (strictNodeLink) {
        this.logger?.warn?.('NodeLink returned no playable tracks for URL', {
          url,
          routingMode: nodeLinkRoutingMode,
        });
        throw new ValidationError(`NodeLink returned no playable tracks for ${url}.`);
      }
    }
    return this._resolveTracksFromSource(url, requestedBy, safeLimit);
  },

  async _resolveTracksFromSource(url: string, requestedBy: string | null, limit?: number | null) {
    const safeLimit = normalizeResolveLimit(limit, this.maxPlaylistTracks);
    const isGenericStreamPlaylist = !isYouTubeUrl(url) && isLikelyPlaylistUrl(url);
    if (isGenericStreamPlaylist) {
      return this.sources.resolver.resolveSingleUrlTrack(url, requestedBy);
    }

    const validation = await playdl.validate(url).catch(() => false);
    const playlistUrl = toCanonicalYouTubePlaylistUrl(url);
    const effectiveValidation = playlistUrl ? 'yt_playlist' : validation;

    switch (effectiveValidation) {
      case 'yt_video':
        return this._resolveSingleYouTubeTrack(url, requestedBy);
      case 'yt_playlist':
        return this._resolveYouTubePlaylistTracks(playlistUrl ?? url, requestedBy, {
          fallbackWatchUrl: toCanonicalYouTubeWatchUrl(url) ?? inferYouTubeWatchUrlFromPlaylist(url),
          limit: safeLimit,
        });
      case 'so_track':
        return this.sources.soundcloud.resolveTrack(url, requestedBy);
      case 'so_playlist':
        return this.sources.soundcloud.resolvePlaylist(url, requestedBy, safeLimit);
      case 'dz_track':
        return this.sources.deezer.resolveTrack(url, requestedBy);
      case 'dz_playlist':
      case 'dz_album':
        return this.sources.deezer.resolveCollection(url, requestedBy, safeLimit);
      default:
        if (isAudiusUrl(url)) return this.sources.audius.resolveByUrl(url, requestedBy);
        if (isSoundCloudUrl(url)) return this.sources.soundcloud.resolveByGuess(url, requestedBy, safeLimit);
        if (isDeezerUrl(url)) return this.sources.deezer.resolveByGuess(url, requestedBy, safeLimit);
        return this.sources.resolver.resolveSingleUrlTrack(url, requestedBy);
    }
  },

  async _resolveSearchTrack(query: string, requestedBy: string | null) {
    const nodeLinkRoutingMode = getNodeLinkRoutingMode(this.nodeLinkRoutingMode);
    const nodeLinkAvailable = Boolean(
      this.nodeLinkEnabled && this.nodeLinkClient?.enabled && nodeLinkRoutingMode !== 'youtube-only'
    );

    if (nodeLinkAvailable && nodeLinkRoutingMode === 'all') {
      return this._resolveNodeLinkTracks(query, requestedBy, 1);
    }

    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this.sources.deezer.searchTracks(query, 1, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    if (nodeLinkAvailable) {
      return this._resolveNodeLinkTracks(query, requestedBy, 1);
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
  },

  getDiagnostics(): ResolverDiagnostics {
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
      nodeLink: this.nodeLinkClient?.getDiagnostics?.() ?? {
        enabled: Boolean(this.nodeLinkEnabled),
        baseUrl: null,
      },
    };
  },

  async searchCandidates(query: string, limit = 5, options: { requestedBy?: string | null } = { requestedBy: null }) {
    const requestedBy = options.requestedBy ?? null;
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this.sources.deezer.searchTracks(query, safeLimit, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    const nodeLinkRoutingMode = getNodeLinkRoutingMode(this.nodeLinkRoutingMode);
    if (this.nodeLinkEnabled && this.nodeLinkClient?.enabled && nodeLinkRoutingMode !== 'youtube-only') {
      return this._resolveNodeLinkTracks(query, requestedBy, safeLimit, { searchIdentifier: 'search' });
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
  },

  async _searchYouTubeTracks(query: string, limit: number, requestedBy: string | null) {
    let results: unknown[] = [];
    try {
      results = await this._searchWithYtDlp(query, limit);
    } catch (err) {
      this.logger?.warn?.('yt-dlp searchCandidates failed, trying play-dl fallback', {
        query,
        limit,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!results.length) {
      results = await playdl.search(query, { source: { youtube: 'video' }, limit }).catch(async (err: unknown) => {
        if (!isPlayDlBrowseFailure(err)) throw err;
        this.logger?.warn?.('play-dl searchCandidates failed after yt-dlp attempt', {
          query,
          limit,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    }

    return results.map((item) => {
      const record = asRecord(item);
      return this._buildTrack({
      title: toText(record?.title),
      url: toText(record?.url),
      duration: toDurationValue(record?.durationRaw ?? record?.duration),
      thumbnailUrl: pickThumbnailUrlFromItem(item),
      requestedBy,
      source: 'youtube-search',
      artist: pickTrackArtistFromMetadata(item),
    });
    });
  },

  async _searchDeezerTracks(query: string, limit: number, requestedBy: string | null) {
    const safeQuery = String(query ?? '').trim();
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    if (!safeQuery || !this.deezerArl || !this.enableDeezerImport) return [];

    const payload = await this._deezerApiRequest(`/search/track?q=${encodeURIComponent(safeQuery)}`).catch(() => null);
    const data = isRecord(payload) ? payload.data : undefined;
    const items = isUnknownArray(data) ? data : [];
    const tracks: Track[] = [];
    for (const item of items) {
      if (tracks.length >= safeLimit) break;
      const track = this._buildDeezerTrackFromMetadata(item, requestedBy, 'deezer-search-direct');
      if (track?.deezerTrackId) {
        tracks.push(track);
      }
    }

    return tracks;
  },

  async previewTracks(query: string, options: { requestedBy?: string | null; limit?: number } = { requestedBy: null, limit: 0 }) {
    const requestedBy = options.requestedBy ?? null;
    const limit = Number.parseInt(String(options.limit ?? 0), 10);
    return this._resolveTracks(query, requestedBy, Number.isFinite(limit) && limit > 0 ? limit : null);
  },

  createTrackFromData(data: TrackInput, requestedBy: string | null = null) {
    const normalizedThumbnailUrl = (
      data?.thumbnailUrl
      ?? data?.thumbnail_url
      ?? data?.thumbnail
      ?? pickThumbnailUrlFromItem(data)
    );
    const normalizedUrl = String(data?.url ?? '').trim();
    const rawSource = String(data?.source ?? 'stored').trim();
    const normalizedSource = rawSource.toLowerCase();
    const explicitIsLive = data?.isLive ?? data?.is_live ?? false;
    const inferredIsLive =
      explicitIsLive === true
      || String(data?.duration ?? '').trim().toLowerCase() === 'live';

    let effectiveSource = rawSource || 'stored';
    if (isHttpUrl(normalizedUrl) && !isYouTubeUrl(normalizedUrl)) {
      const isKnownProviderUrl = (
        isSoundCloudUrl(normalizedUrl)
        || isSpotifyUrl(normalizedUrl)
        || isDeezerUrl(normalizedUrl)
        || isTidalUrl(normalizedUrl)
        || isBandcampUrl(normalizedUrl)
        || isAudiomackUrl(normalizedUrl)
        || isMixcloudUrl(normalizedUrl)
        || isJioSaavnUrl(normalizedUrl)
        || isAmazonMusicUrl(normalizedUrl)
        || isAppleMusicUrl(normalizedUrl)
        || isAudiusUrl(normalizedUrl)
      );

      if (
        !isKnownProviderUrl
        && (
          normalizedSource === 'http'
          || normalizedSource === 'youtube'
          || normalizedSource === 'ytmusic'
          || normalizedSource === 'stored'
          || normalizedSource === 'url'
        )
      ) {
        const unresolvedExtensionlessUrlFallback = (
          normalizedSource === 'url'
          && !isLikelyDirectAudioFileUrl(normalizedUrl)
          && String(data?.duration ?? '').trim().toLowerCase() === 'unknown'
        );
        effectiveSource = inferredIsLive || isLikelyPlaylistUrl(normalizedUrl)
          || unresolvedExtensionlessUrlFallback
          ? 'radio-stream'
          : 'http-audio';
      }
    }

    const nodelinkInfo = data?.nodelinkInfo ?? data?.nodelink_info ?? null;
    return this._buildTrack({
      title: toText(data?.title),
      url: normalizedUrl,
      duration: toDurationValue(data?.duration),
      metadataDeferred: Boolean(data?.metadataDeferred),
      thumbnailUrl: toNullableText(normalizedThumbnailUrl),
      requestedBy: requestedBy ?? toNullableText(data?.requestedBy),
      source: effectiveSource,
      artist: toOptionalText(data?.artist ?? data?.artist_name ?? pickTrackArtistFromMetadata(data)),
      soundcloudTrackId: toOptionalText(data?.soundcloudTrackId ?? data?.soundcloud_track_id),
      audiusTrackId: toOptionalText(data?.audiusTrackId ?? data?.audius_track_id),
      deezerTrackId: toOptionalText(data?.deezerTrackId ?? data?.deezer_track_id),
      deezerPreviewUrl: toNullableText(data?.deezerPreviewUrl ?? data?.deezer_preview_url),
      deezerFullStreamUrl: toNullableText(data?.deezerFullStreamUrl ?? data?.deezer_full_stream_url),
      spotifyTrackId: toOptionalText(data?.spotifyTrackId ?? data?.spotify_track_id),
      spotifyPreviewUrl: toNullableText(data?.spotifyPreviewUrl ?? data?.spotify_preview_url),
      isrc: toOptionalText(data?.isrc),
      nodelinkEncodedTrack: toOptionalText(data?.nodelinkEncodedTrack ?? data?.nodelink_encoded_track),
      nodelinkInfo: asRecord(nodelinkInfo),
      isPreview: Boolean(data?.isPreview ?? data?.is_preview),
      isLive: inferredIsLive || effectiveSource === 'radio-stream',
      seekStartSec: toSeekStartValue(data?.seekStartSec ?? data?.seek_start_sec ?? 0),
    });
  },

  async hydrateTrackMetadata(
    data: TrackInput,
    options: { requestedBy?: string | null } = { requestedBy: null },
  ) {
    const url = String(data?.url ?? '').trim();
    if (!url) return null;

    const requestedBy = options.requestedBy ?? (String(data?.requestedBy ?? '').trim() || null);
    const isDeferredYouTubeTrack = isYouTubeUrl(url) && data?.metadataDeferred === true;
    if (!isDeferredYouTubeTrack) return null;

    try {
      return await this._resolveSingleYouTubeTrackViaYtDlp(url, requestedBy);
    } catch (err) {
      this.logger?.warn?.('yt-dlp deferred YouTube metadata hydration failed, trying play-dl fallback', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const info = await this._fetchSingleYouTubeTrackViaPlayDl(url);
      return this._buildTrack({
        title: info.video_details.title ?? '',
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'youtube',
        artist: pickTrackArtistFromMetadata(info.video_details),
      });
    } catch (err) {
      this.logger?.warn?.('play-dl deferred YouTube metadata hydration failed after yt-dlp attempt', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  },

  async _resolveSingleYouTubeTrack(url: string, requestedBy: string | null) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    try {
      const fallback = await this._resolveSingleYouTubeTrackViaYtDlp(url, requestedBy);
      return [fallback];
    } catch (err) {
      this.logger?.warn?.('yt-dlp single YouTube metadata lookup failed, trying play-dl fallback', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const info = await this._fetchSingleYouTubeTrackViaPlayDl(url);
      return [this._buildTrack({
        title: info.video_details.title ?? '',
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'youtube',
        artist: pickTrackArtistFromMetadata(info.video_details),
      })];
    } catch (err) {
      this.logger?.warn?.('play-dl single YouTube metadata lookup failed after yt-dlp attempt', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });

      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'youtube',
      })];
    }
  },

  async _fetchSingleYouTubeTrackViaPlayDl(url: string) {
    return playdl.video_info(url);
  },

  async _resolveSingleYouTubeTrackViaYtDlp(url: string, requestedBy: string | null) {
    const strategies = this._getYtDlpClientStrategies?.() ?? [false];
    let lastErr: unknown = null;

    for (const strategy of strategies) {
      const args = [
        '--ignore-config',
        '--quiet',
        '--no-warnings',
        '--skip-download',
        '--dump-single-json',
      ];

      const clientArg = this._resolveYtDlpClientArg?.(strategy) ?? null;
      if (clientArg) {
        args.push('--extractor-args', `youtube:player_client=${clientArg}`);
      }
      const activeCookiesFile = this._getActiveYtDlpCookiesFile?.() ?? null;
      if (activeCookiesFile) {
        args.push('--cookies', activeCookiesFile);
      }
      if (this.ytdlpCookiesFromBrowser) {
        args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
      }
      if (this.ytdlpExtraArgs.length) {
        args.push(...this.ytdlpExtraArgs);
      }

      args.push(url);

      try {
        const { stdout } = await this._runYtDlpCommandWithProxyFallback(args, 15_000, {
          context: 'youtube-single',
        });
        if (!stdout?.trim()) {
          throw new Error('yt-dlp returned empty metadata payload.');
        }

        let payload: unknown;
        try {
          payload = JSON.parse(stdout);
        } catch {
          throw new Error('yt-dlp returned invalid JSON metadata.');
        }

        const record = asRecord(payload);
        const resolvedUrl = String(record?.webpage_url ?? '').trim() || toCanonicalYouTubeWatchUrl(url) || url;
        const title = String(record?.title ?? '').trim() || resolvedUrl;

        return this._buildTrack({
          title,
          url: resolvedUrl,
          duration: toDurationValue(record?.duration_string ?? record?.duration ?? 'Unknown'),
          thumbnailUrl: pickThumbnailUrlFromItem(payload),
          requestedBy,
          source: 'youtube',
          artist: pickTrackArtistFromMetadata(payload) || String(record?.channel ?? record?.uploader ?? '').trim() || null,
        });
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr ?? new Error('yt-dlp metadata lookup failed');
  },

  async _resolveYouTubePlaylistTracks(
    url: string,
    requestedBy: string | null,
    options: YouTubePlaylistResolveOptions = { fallbackWatchUrl: null, limit: null }
  ) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const safeLimit = normalizeResolveLimit(options.limit, this.maxPlaylistTracks);
    const watchUrl = options.fallbackWatchUrl ?? inferYouTubeWatchUrlFromPlaylist(url) ?? toCanonicalYouTubeWatchUrl(url);

    // For watch-context mixes/radios, start immediately with the visible track
    // instead of waiting for a playlist resolver to enumerate entries first.
    if (safeLimit === 1 && watchUrl) {
      if (isYouTubeWatchContextMixUrl(url)) {
        return [this._buildTrack({
          title: 'YouTube Mix Track',
          url: watchUrl,
          duration: 'Unknown',
          requestedBy,
          source: 'youtube',
        })];
      }
      return this._resolveSingleYouTubeTrack(watchUrl, requestedBy);
    }

    const order = this.youtubePlaylistResolver === 'playdl' ? ['playdl', 'ytdlp'] : ['ytdlp', 'playdl'];
    const resolverErrors: Array<{ resolver: string; error: unknown }> = [];

    for (const resolver of order) {
      if (resolver === 'ytdlp') {
        try {
          const tracks = await this._resolveYouTubePlaylistTracksViaYtDlp(url, requestedBy, safeLimit);
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
        const tracks = await this._resolveYouTubePlaylistTracksViaPlayDl(url, requestedBy, safeLimit);
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
  },

  async _fetchYouTubePlaylistInfo(url: string) {
    return playdl.playlist_info(url, { incomplete: true });
  },

  async _resolveYouTubePlaylistTracksViaPlayDl(url: string, requestedBy: string | null, limit?: number | null) {
    const safeLimit = normalizeResolveLimit(limit, this.maxPlaylistTracks);
    const playlist = await this._fetchYouTubePlaylistInfo(url);
    await playlist.fetch(safeLimit);
    const videos: unknown[] = [];

    for (let page = 1; page <= playlist.total_pages && videos.length < safeLimit; page += 1) {
      const items = playlist.page(page) ?? [];
      for (const item of items) {
        videos.push(item);
        if (videos.length >= safeLimit) break;
      }
    }

    const initialVideos = readPlaylistVideos(playlist);
    if (!videos.length && isUnknownArray(initialVideos)) {
      videos.push(...initialVideos.slice(0, safeLimit));
    }

    return videos.map((video) => {
      const record = asRecord(video);
      return this._buildTrack({
        title: toText(record?.title),
        url: toText(record?.url),
        duration: toDurationValue(record?.durationRaw),
        thumbnailUrl: pickThumbnailUrlFromItem(video),
        requestedBy,
        source: 'youtube-playlist',
        artist: pickTrackArtistFromMetadata(video),
      });
    });
  },

  async _resolveYouTubePlaylistTracksViaYtDlp(url: string, requestedBy: string | null, limit?: number | null) {
    const safeLimit = normalizeResolveLimit(limit, this.maxPlaylistTracks);
    const strategies = this._getYtDlpClientStrategies?.() ?? [false];

    for (const strategy of strategies) {
      const args = [
        '--ignore-config',
        '--quiet',
        '--no-warnings',
        '--skip-download',
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-end', String(safeLimit),
      ];

      const clientArg = this._resolveYtDlpClientArg?.(strategy) ?? null;
      if (clientArg) {
        args.push('--extractor-args', `youtube:player_client=${clientArg}`);
      }
      const activeCookiesFile = this._getActiveYtDlpCookiesFile?.() ?? null;
      if (activeCookiesFile) {
        args.push('--cookies', activeCookiesFile);
      }
      if (this.ytdlpCookiesFromBrowser) {
        args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
      }
      if (this.ytdlpExtraArgs.length) {
        args.push(...this.ytdlpExtraArgs);
      }

      args.push(url);

      const { stdout } = await this._runYtDlpCommandWithProxyFallback(args, 25_000, {
        context: 'youtube-playlist',
      }).catch(() => ({ stdout: '' }));
      if (!stdout?.trim()) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(stdout);
      } catch {
        continue;
      }

      const rawEntries = isRecord(payload) ? payload.entries : undefined;
      const entries = isUnknownArray(rawEntries) ? rawEntries : [];
      const tracks: Track[] = [];

      for (const entry of entries) {
        if (tracks.length >= safeLimit) break;
        const videoUrl = normalizeYouTubeVideoUrlFromEntry(entry);
        if (!videoUrl) continue;

        const entryRecord = asRecord(entry);
        const title = String(entryRecord?.title ?? '').trim() || videoUrl;
        const entryDuration = entryRecord?.duration;
        const duration = typeof entryDuration === 'number' && Number.isFinite(entryDuration) ? entryDuration : 'Unknown';
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

      if (tracks.length) {
        return tracks;
      }
    }

    return [];
  },
};
