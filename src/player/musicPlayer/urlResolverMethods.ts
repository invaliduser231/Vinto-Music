import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';
import {
  isHttpUrl,
  isLikelyDirectAudioFileUrl,
  isLikelyPlaylistUrl,
  pickArtistName,
  pickThumbnailUrlFromItem,
  sanitizeUrlToSearchQuery,
  toDurationLabel,
} from './trackUtils.ts';
type HeaderLike = { get?: (name: string) => string | null } | null | undefined;
type CrossSourceTrack = Record<string, unknown> & {
  title?: unknown;
  name?: unknown;
  artist?: unknown;
  artistName?: unknown;
  creator?: unknown;
  uploader?: unknown;
  author?: unknown;
  durationInSec?: unknown;
};
type UrlResolverMethods = {
  _resolveSpotifyTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveSpotifyCollection(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveCrossSourceToYouTube(sourceTracks: CrossSourceTrack[], requestedBy: string | null, source: string): Promise<Track[]>;
  _resolveSingleUrlTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveDirectHttpAudioTrack(url: string, requestedBy: string | null): Promise<Track | null>;
  _resolveRadioStreamTrack(url: string, requestedBy: string | null, seen?: Set<string> | null): Promise<Track | null>;
  _resolveSoundCloudByGuess(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveDeezerByGuess(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveSpotifyByGuess(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveFromUrlFallbackSearch(url: string, requestedBy: string | null, source: string): Promise<Track[]>;
  _normalizeInputUrl(url: unknown): Promise<string>;
};
type UrlResolverRuntime = MusicPlayer & UrlResolverMethods;
type NormalizedInputUrlCacheEntry = { url: string; expiresAtMs: number };

const SHORT_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const SHORT_URL_HEAD_TIMEOUT_MS = 2_500;
const SHORT_URL_GET_TIMEOUT_MS = 4_000;

function isRadioPlaylistContentType(contentType: unknown) {
  const normalized = String(contentType ?? '').toLowerCase();
  return (
    normalized.includes('audio/x-mpegurl')
    || normalized.includes('audio/mpegurl')
    || normalized.includes('application/vnd.apple.mpegurl')
    || normalized.includes('application/x-mpegurl')
    || normalized.includes('audio/x-scpls')
    || normalized.includes('application/pls+xml')
    || normalized.includes('application/x-scpls')
  );
}

function isAudioStreamContentType(contentType: unknown) {
  const normalized = String(contentType ?? '').toLowerCase();
  return (
    normalized.startsWith('audio/')
    || normalized.includes('application/ogg')
    || normalized.includes('application/octet-stream')
  );
}

function extractFirstHttpLine(lines: unknown[]) {
  for (const line of lines) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return null;
}

function extractFirstPlaylistTargetLine(lines: unknown[], baseUrl: string | null = null) {
  for (const line of lines) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      if (baseUrl) {
        return new URL(trimmed, baseUrl).toString();
      }
    } catch {}
  }
  return null;
}

function parseRadioPlaylistBody(body: unknown, baseUrl: string | null = null) {
  const text = String(body ?? '');
  if (!text.trim()) return null;

  const isHlsPlaylist = text.includes('#EXTM3U');
  const isHlsMediaPlaylist = /#EXTINF:|#EXT-X-TARGETDURATION:|#EXT-X-MEDIA-SEQUENCE:/i.test(text);
  if (isHlsPlaylist && isHlsMediaPlaylist && baseUrl) {
    return baseUrl;
  }

  const lines = text.split(/\r?\n/);
  const direct = extractFirstHttpLine(lines);
  if (direct) return direct;

  for (const line of lines) {
    const match = String(line ?? '').match(/^File\d+=(https?:\/\/.+)$/i);
    const playlistTarget = match?.[1];
    if (playlistTarget) return playlistTarget.trim();
  }

  const relativeTarget = extractFirstPlaylistTargetLine(lines, baseUrl);
  if (relativeTarget) return relativeTarget;

  if (isHlsPlaylist && baseUrl) {
    return baseUrl;
  }

  return null;
}

function buildRadioTitle(url: string, headers: HeaderLike) {
  for (const key of ['icy-name', 'ice-name', 'x-audiocast-name']) {
    const value = String(headers?.get?.(key) ?? '').trim();
    if (value) return value;
  }

  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname ?? '').trim();
    return host ? `${host} Live` : 'Live Radio';
  } catch {
    return 'Live Radio';
  }
}

function buildHttpAudioTitle(url: string, headers: HeaderLike) {
  const disposition = String(headers?.get?.('content-disposition') ?? '').trim();
  const fileNameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  const fileName = fileNameMatch?.[1];
  if (fileName) {
    const value = decodeURIComponent(String(fileName).replace(/"/g, '').trim());
    if (value) return value;
  }

  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const decoded = decodeURIComponent(lastSegment).trim();
    if (decoded) return decoded;
  } catch {}

  return url;
}

function hasStationHeaders(headers: HeaderLike) {
  return Boolean(
    headers?.get?.('icy-name')
    || headers?.get?.('ice-name')
    || headers?.get?.('x-audiocast-name')
  );
}

function isDirectHttpAudioCandidate({ contentType, finalUrl, headers }: { contentType: unknown; finalUrl: string; headers: HeaderLike }) {
  const hasIcyHeaders = hasStationHeaders(headers);
  if (!isAudioStreamContentType(contentType) || hasIcyHeaders) return false;
  if (isRadioPlaylistContentType(contentType) || isLikelyPlaylistUrl(finalUrl)) return false;

  const contentDisposition = String(headers?.get?.('content-disposition') ?? '').toLowerCase();
  const looksLikeAttachment = contentDisposition.includes('attachment') || contentDisposition.includes('filename=');
  if (!looksLikeAttachment && !isLikelyDirectAudioFileUrl(finalUrl) && contentType === 'audio/mpeg') {
    return false;
  }

  return true;
}

function resolveSourceArtist(sourceTrack: CrossSourceTrack | null | undefined) {
  const nestedArtist = pickArtistName(sourceTrack);
  if (nestedArtist) return nestedArtist;

  const candidates = [
    sourceTrack?.artist,
    sourceTrack?.artistName,
    sourceTrack?.creator,
    sourceTrack?.uploader,
    sourceTrack?.author,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }

  return null;
}

export const urlResolverMethods: UrlResolverMethods & ThisType<UrlResolverRuntime> = {
  async _resolveSpotifyTrack(_url: string, _requestedBy: string | null) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  },

  async _resolveSpotifyCollection(_url: string, _requestedBy: string | null) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  },

  async _resolveCrossSourceToYouTube(sourceTracks: CrossSourceTrack[], requestedBy: string | null, source: string) {
    if (!this.enableYtSearch) {
      throw new ValidationError('Cross-source imports require YouTube search, which is currently disabled.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('Cross-source imports require YouTube playback, which is currently disabled.');
    }

    const resolved = [];
    for (const sourceTrack of sourceTracks) {
      const title = String(sourceTrack?.title ?? sourceTrack?.name ?? 'Unknown title').trim() || 'Unknown title';
      const artist = resolveSourceArtist(sourceTrack);
      const query = artist ? `${artist} - ${title}` : title;
      const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(() => []);
      if (!result.length) continue;
      const firstResult = result[0]!;

      resolved.push(this._buildTrack({
        title: firstResult.title || title,
        url: firstResult.url,
        duration: firstResult.durationRaw || toDurationLabel(sourceTrack.durationInSec),
        thumbnailUrl: pickThumbnailUrlFromItem(firstResult),
        requestedBy,
        source,
      }));
    }

    if (!resolved.length) {
      throw new ValidationError(`No playable YouTube matches found for ${source} source.`);
    }
    return resolved;
  },

  async _resolveSingleUrlTrack(url: string, requestedBy: string | null) {
    if (isLikelyPlaylistUrl(url) && !isLikelyDirectAudioFileUrl(url)) {
      const radioTrack = await this._resolveRadioStreamTrack(url, requestedBy).catch(() => null);
      if (radioTrack) {
        return [radioTrack];
      }

      return [this._buildTrack({
        title: buildRadioTitle(url, null),
        url,
        duration: 'Live',
        requestedBy,
        source: 'radio-stream',
        isLive: true,
      })];
    }

    const directAudioTrack = await this._resolveDirectHttpAudioTrack(url, requestedBy).catch(() => null);
    if (directAudioTrack) {
      return [directAudioTrack];
    }

    const radioTrack = await this._resolveRadioStreamTrack(url, requestedBy).catch(() => null);
    if (radioTrack) {
      return [radioTrack];
    }

    try {
      const info = await playdl.video_info(url);
      return [this._buildTrack({
        title: String(info.video_details.title ?? url).trim() || url,
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
  },

  async _resolveDirectHttpAudioTrack(url: string, requestedBy: string | null) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!response?.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    const finalUrl = String(response.url ?? url).trim() || url;

    try {
      await response.body?.cancel?.();
    } catch {}

    if (!isDirectHttpAudioCandidate({ contentType, finalUrl, headers: response.headers })) {
      return null;
    }

    const probe = await (this._probeHttpAudioTrack as ((url: string) => Promise<{ title: string | null; artist: string | null; durationSec: number | null } | null>))(finalUrl).catch(() => null);
    return this._buildTrack({
      title: String(probe?.title ?? '').trim() || buildHttpAudioTitle(finalUrl, response.headers),
      url: finalUrl,
      duration: probe?.durationSec ?? 'Unknown',
      requestedBy,
      source: 'http-audio',
      artist: String(probe?.artist ?? '').trim() || null,
      isLive: false,
    });
  },

  async _resolveRadioStreamTrack(url: string, requestedBy: string | null, seen: Set<string> | null = null) {
    const visited = seen instanceof Set ? seen : new Set<string>();
    const normalizedUrl = String(url ?? '').trim();
    if (!normalizedUrl || visited.has(normalizedUrl)) return null;
    visited.add(normalizedUrl);

    const response = await fetch(normalizedUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'Icy-MetaData': '1',
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!response?.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    const finalUrl = String(response.url ?? normalizedUrl).trim() || normalizedUrl;
    const hasIcyHeaders = hasStationHeaders(response.headers);

    if (isRadioPlaylistContentType(contentType) || isLikelyPlaylistUrl(finalUrl)) {
      const playlistBody = await response.text().catch(() => '');
      const nestedUrl = parseRadioPlaylistBody(playlistBody, finalUrl);
      if (!nestedUrl || !isHttpUrl(nestedUrl)) return null;
      if (nestedUrl === finalUrl) {
        const title = buildRadioTitle(finalUrl, response.headers);
        return this._buildTrack({
          title,
          url: finalUrl,
          duration: 'Live',
          requestedBy,
          source: 'radio-stream',
          isLive: true,
        });
      }
      return this._resolveRadioStreamTrack(nestedUrl, requestedBy, visited);
    }

    if (!isAudioStreamContentType(contentType) && !hasIcyHeaders) {
      try {
        await response.body?.cancel?.();
      } catch {
        // ignore early body cancellation errors
      }
      return null;
    }

    if (!hasIcyHeaders && isLikelyDirectAudioFileUrl(finalUrl)) {
      try {
        await response.body?.cancel?.();
      } catch {}
      return null;
    }

    try {
      await response.body?.cancel?.();
    } catch {
      // ignore early body cancellation errors
    }

    const title = buildRadioTitle(finalUrl, response.headers);
    return this._buildTrack({
      title,
      url: finalUrl,
      duration: 'Live',
      requestedBy,
      source: 'radio-stream',
      isLive: true,
    });
  },

  async _resolveSoundCloudByGuess(url: string, requestedBy: string | null) {
    try {
      if (url.includes('/sets/')) {
        return await this._resolveSoundCloudPlaylist(url, requestedBy);
      }
      return await this._resolveSoundCloudTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }
  },

  async _resolveDeezerByGuess(url: string, requestedBy: string | null) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveDeezerCollection(url, requestedBy);
      }
      return await this._resolveDeezerTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'deezer-fallback');
    }
  },

  async _resolveSpotifyByGuess(url: string, requestedBy: string | null) {
    if (url.includes('/artist/')) {
      return this._resolveSpotifyArtist(url, requestedBy);
    }
    if (url.includes('/playlist/') || url.includes('/album/')) {
      return this._resolveSpotifyCollection(url, requestedBy);
    }
    return this._resolveSpotifyTrack(url, requestedBy);
  },

  async _resolveFromUrlFallbackSearch(url: string, requestedBy: string | null, source: string) {
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
    const firstResult = result[0]!;

    return [this._buildTrack({
      title: firstResult.title || query,
      url: firstResult.url,
      duration: firstResult.durationRaw,
      thumbnailUrl: pickThumbnailUrlFromItem(firstResult),
      requestedBy,
      source,
    })];
  },

  async _normalizeInputUrl(url: unknown) {
    let trimmed = String(url ?? '').trim();
    if (!isHttpUrl(trimmed)) return trimmed;

    const htmlDecoded = trimmed.replace(/&amp;/gi, '&').replace(/&#38;/gi, '&');
    if (htmlDecoded !== trimmed && isHttpUrl(htmlDecoded)) {
      trimmed = htmlDecoded;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === 'music.youtube.com') {
        parsed.hostname = 'www.youtube.com';
        return parsed.toString();
      }
      const shouldExpand = (
        parsed.hostname.includes('link.deezer.com')
        || parsed.hostname.includes('on.soundcloud.com')
        || parsed.hostname === 'spoti.fi'
        || parsed.hostname.includes('spotify.link')
      );
      if (shouldExpand) {
        const cached = this.normalizedInputUrlCache.get(trimmed) as NormalizedInputUrlCacheEntry | undefined;
        if (cached && cached.expiresAtMs > Date.now() && isHttpUrl(cached.url)) {
          return cached.url;
        }

        const response = await fetch(trimmed, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(SHORT_URL_HEAD_TIMEOUT_MS),
        }).catch(() => null)
          ?? await fetch(trimmed, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(SHORT_URL_GET_TIMEOUT_MS),
          }).catch(() => null);

        if (response?.url && isHttpUrl(response.url)) {
          this.normalizedInputUrlCache.set(trimmed, {
            url: response.url,
            expiresAtMs: Date.now() + SHORT_URL_CACHE_TTL_MS,
          });
          return response.url;
        }
      }
    } catch {
      return trimmed;
    }

    return trimmed;
  },
};


