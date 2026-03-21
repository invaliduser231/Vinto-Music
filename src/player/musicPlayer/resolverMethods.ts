import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import { isPlayDlBrowseFailure } from './errorUtils.ts';
import type { Track } from '../../types/domain.ts';
import {
  inferYouTubeWatchUrlFromPlaylist,
  isAmazonMusicUrl,
  isAppleMusicUrl,
  isAudiusUrl,
  isDeezerUrl,
  isHttpUrl,
  isLikelyPlaylistUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isYouTubeUrl,
  normalizeYouTubeVideoUrlFromEntry,
  pickThumbnailUrlFromItem,
  pickTrackArtistFromMetadata,
  toCanonicalYouTubePlaylistUrl,
  toCanonicalYouTubeWatchUrl,
} from './trackUtils.ts';

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type SearchResultLike = Record<string, unknown> & {
  title?: unknown;
  url?: unknown;
  durationRaw?: unknown;
  duration?: unknown;
};

export const resolverMethods: LooseMethodMap = {
  async _resolveTracks(query: string, requestedBy: string | null) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      throw new ValidationError('Missing query.');
    }

    if (!isHttpUrl(raw)) {
      return this._resolveSearchTrack(raw, requestedBy);
    }

    const url = await this.sources.resolver.normalizeInputUrl(raw);
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
        if (isAudiusUrl(url)) return this.sources.audius.resolveByUrl(url, requestedBy);
        if (isSoundCloudUrl(url)) return this.sources.soundcloud.resolveByGuess(url, requestedBy);
        if (isDeezerUrl(url)) return this.sources.deezer.resolveByGuess(url, requestedBy);
        if (isSpotifyUrl(url)) return this.sources.resolver.resolveSpotifyByGuess(url, requestedBy);
        if (isAmazonMusicUrl(url)) return this.sources.resolver.resolveAmazonByGuess(url, requestedBy);
        if (isAppleMusicUrl(url)) return this.sources.resolver.resolveAppleByGuess(url, requestedBy);
        return this.sources.resolver.resolveSingleUrlTrack(url, requestedBy);
    }
  },

  async _resolveSearchTrack(query: string, requestedBy: string | null) {
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
  },

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
  },

  async searchCandidates(query: string, limit = 5, options: { requestedBy?: string | null } = { requestedBy: null }) {
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
  },

  async _searchYouTubeTracks(query: string, limit: number, requestedBy: string | null) {
    let results = [];
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
      results = await playdl.search(query, { source: { youtube: 'video' }, limit }).catch(async (err) => {
        if (!isPlayDlBrowseFailure(err)) throw err;
        this.logger?.warn?.('play-dl searchCandidates failed after yt-dlp attempt', {
          query,
          limit,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    }

    return results.map((item: unknown) => {
      const typedItem = item as SearchResultLike;
      return this._buildTrack({
      title: typedItem.title,
      url: typedItem.url,
      duration: typedItem.durationRaw ?? typedItem.duration,
      thumbnailUrl: pickThumbnailUrlFromItem(typedItem),
      requestedBy,
      source: 'youtube-search',
      artist: pickTrackArtistFromMetadata(typedItem),
    });
    });
  },

  async _searchDeezerTracks(query: string, limit: number, requestedBy: string | null) {
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
  },

  async previewTracks(query: string, options: { requestedBy?: string | null; limit?: number } = { requestedBy: null, limit: 0 }) {
    const requestedBy = options.requestedBy ?? null;
    const tracks = await this._resolveTracks(query, requestedBy);
    const limit = Number.parseInt(String(options.limit ?? 0), 10);
    if (Number.isFinite(limit) && limit > 0) {
      return tracks.slice(0, limit);
    }
    return tracks;
  },

  createTrackFromData(data: Record<string, unknown>, requestedBy: string | null = null) {
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
      requestedBy: requestedBy ?? data?.requestedBy ?? null,
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
      isLive: data?.isLive ?? data?.is_live ?? false,
      seekStartSec: data?.seekStartSec ?? data?.seek_start_sec ?? 0,
    });
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
        title: info.video_details.title,
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
    if (this.ytdlpExtraArgs.length) {
      args.push(...this.ytdlpExtraArgs);
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

    const resolvedUrl = String(payload?.webpage_url ?? '').trim() || toCanonicalYouTubeWatchUrl(url) || url;
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
  },

  async _resolveYouTubePlaylistTracks(url: string, requestedBy: string | null, options: { fallbackWatchUrl?: string | null } = { fallbackWatchUrl: null }) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const order = this.youtubePlaylistResolver === 'playdl' ? ['playdl', 'ytdlp'] : ['ytdlp', 'playdl'];
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
  },

  async _fetchYouTubePlaylistInfo(url: string) {
    return playdl.playlist_info(url, { incomplete: true });
  },

  async _resolveYouTubePlaylistTracksViaPlayDl(url: string, requestedBy: string | null) {
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
  },

  async _resolveYouTubePlaylistTracksViaYtDlp(url: string, requestedBy: string | null) {
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
    if (this.ytdlpExtraArgs.length) {
      args.push(...this.ytdlpExtraArgs);
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

    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
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
  },
};
