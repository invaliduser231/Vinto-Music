import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.js';
import {
  isHttpUrl,
  pickArtistName,
  pickThumbnailUrlFromItem,
  sanitizeUrlToSearchQuery,
  toDurationLabel,
} from './trackUtils.js';

function isRadioPlaylistContentType(contentType) {
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

function isAudioStreamContentType(contentType) {
  const normalized = String(contentType ?? '').toLowerCase();
  return (
    normalized.startsWith('audio/')
    || normalized.includes('application/ogg')
    || normalized.includes('application/octet-stream')
  );
}

function isLikelyPlaylistUrl(value) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.includes('.m3u') || normalized.includes('.m3u8') || normalized.includes('.pls');
}

function extractFirstHttpLine(lines) {
  for (const line of lines) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return null;
}

function parseRadioPlaylistBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return null;

  const lines = text.split(/\r?\n/);
  const direct = extractFirstHttpLine(lines);
  if (direct) return direct;

  for (const line of lines) {
    const match = String(line ?? '').match(/^File\d+=(https?:\/\/.+)$/i);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function buildRadioTitle(url, headers) {
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

function resolveSourceArtist(sourceTrack) {
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

export const urlResolverMethods = {
  async _resolveSpotifyTrack(_url, _requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  },

  async _resolveSpotifyCollection(_url, _requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  },

  async _resolveCrossSourceToYouTube(sourceTracks, requestedBy, source) {
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
  },

  async _resolveSingleUrlTrack(url, requestedBy) {
    const radioTrack = await this._resolveRadioStreamTrack(url, requestedBy).catch(() => null);
    if (radioTrack) {
      return [radioTrack];
    }

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
  },

  async _resolveRadioStreamTrack(url, requestedBy, seen = null) {
    const visited = seen instanceof Set ? seen : new Set();
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

    if (isRadioPlaylistContentType(contentType) || isLikelyPlaylistUrl(finalUrl)) {
      const playlistBody = await response.text().catch(() => '');
      const nestedUrl = parseRadioPlaylistBody(playlistBody);
      if (!nestedUrl || !isHttpUrl(nestedUrl)) return null;
      return this._resolveRadioStreamTrack(nestedUrl, requestedBy, visited);
    }

    if (!isAudioStreamContentType(contentType) && !response.headers.get('icy-name')) {
      try {
        await response.body?.cancel?.();
      } catch {
        // ignore early body cancellation errors
      }
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

  async _resolveSoundCloudByGuess(url, requestedBy) {
    try {
      if (url.includes('/sets/')) {
        return await this._resolveSoundCloudPlaylist(url, requestedBy);
      }
      return await this._resolveSoundCloudTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }
  },

  async _resolveDeezerByGuess(url, requestedBy) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveDeezerCollection(url, requestedBy);
      }
      return await this._resolveDeezerTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'deezer-fallback');
    }
  },

  async _resolveSpotifyByGuess(url, requestedBy) {
    if (url.includes('/artist/')) {
      return this._resolveSpotifyArtist(url, requestedBy);
    }
    if (url.includes('/playlist/') || url.includes('/album/')) {
      return this._resolveSpotifyCollection(url, requestedBy);
    }
    return this._resolveSpotifyTrack(url, requestedBy);
  },

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
  },

  async _normalizeInputUrl(url) {
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
  },
};
