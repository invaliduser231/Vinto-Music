import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.js';
import {
  isHttpUrl,
  pickArtistName,
  pickThumbnailUrlFromItem,
  sanitizeUrlToSearchQuery,
  toDurationLabel,
} from './trackUtils.js';

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
  },

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
  },
};
