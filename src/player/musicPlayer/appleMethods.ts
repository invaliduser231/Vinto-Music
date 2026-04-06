import { ValidationError } from '../../core/errors.ts';
import {
  extractAppleMusicEntity,
  normalizeThumbnailUrl,
  sanitizeUrlToSearchQuery,
} from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

const ITUNES_LOOKUP_BASE = 'https://itunes.apple.com/lookup';
const APPLE_PAGE_TIMEOUT_MS = 10_000;

type AppleLookupResult = Record<string, unknown> & {
  wrapperType?: unknown;
  trackName?: unknown;
  name?: unknown;
  artistName?: unknown;
  trackViewUrl?: unknown;
  collectionViewUrl?: unknown;
  artistViewUrl?: unknown;
  trackTimeMillis?: unknown;
  collectionTimeMillis?: unknown;
  artworkUrl100?: unknown;
  artworkUrl60?: unknown;
  trackId?: unknown;
};
type ApplePageMetadata = {
  title?: string | null;
  description?: string | null;
  thumbnailUrl?: string | null;
} | null;
type AppleMetadataTrack = Partial<Track> & {
  title?: string;
  artist?: string | null;
  duration?: string | number;
};
type CrossSourceSeed = {
  title?: string;
  artist?: string | null;
  durationInSec?: number | null;
};
type ApplePlayer = MusicPlayer & {
  _buildTrack: (input: Record<string, unknown>) => Track;
  _cloneTrack: (track: Track, overrides?: Partial<Track>) => Track;
  _pickMirrorSearchQuery: (track: AppleMetadataTrack) => string | null;
  _searchYouTubeTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _searchDeezerTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _pickBestSpotifyMirror: (metadataTrack: AppleMetadataTrack, candidates: unknown) => Track | null;
  _resolveCrossSourceToYouTube: (sourceTracks: CrossSourceSeed[], requestedBy: string | null, source: string) => Promise<Track[]>;
};
type AppleMethods = {
  _appleLookup(query?: Record<string, unknown>): Promise<AppleLookupResult[]>;
  _fetchApplePageMetadata(url: string): Promise<ApplePageMetadata>;
  _buildAppleMetadataTrack(meta: AppleLookupResult | null | undefined, requestedBy: string | null, source?: string): Track;
  _buildAppleFallbackTrack(url: string, metadata: ApplePageMetadata, requestedBy: string | null, source?: string): AppleMetadataTrack;
  _resolveAppleFallbackSearch(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveAppleMirror(metadataTrack: AppleMetadataTrack, requestedBy: string | null): Promise<Track[]>;
  _resolveAppleTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveAppleCollection(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveAppleByGuess(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
};

function normalizeAppleCollectionLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

function toAppleDurationSeconds(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed / 1000);
}

function decodeHtmlEntities(value: unknown) {
  return String(value ?? '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function matchMetaTag(html: string, attribute: string, name: string) {
  const pattern = new RegExp(
    `<meta[^>]+${attribute}=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  return html.match(pattern)?.[1] ?? null;
}

function toArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export const appleMethods: AppleMethods & ThisType<MusicPlayer> = {
  async _appleLookup(query = {}) {
    const endpoint = new URL(ITUNES_LOOKUP_BASE);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null || value === '') continue;
      endpoint.searchParams.set(key, String(value));
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(APPLE_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Apple lookup failed (${response?.status ?? 'network'})`);
    }

    const payload = await response.json().catch(() => null) as { results?: unknown[] } | null;
    return toArray(payload?.results);
  },

  async _fetchApplePageMetadata(url) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(APPLE_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!response?.ok) return null;

    const html = await response.text().catch(() => '');
    if (!html) return null;

    const title = decodeHtmlEntities(
      matchMetaTag(html, 'property', 'og:title')
      ?? matchMetaTag(html, 'name', 'twitter:title')
      ?? ''
    );
    const description = decodeHtmlEntities(
      matchMetaTag(html, 'property', 'og:description')
      ?? matchMetaTag(html, 'name', 'description')
      ?? ''
    );
    const image = normalizeThumbnailUrl(
      matchMetaTag(html, 'property', 'og:image')
      ?? matchMetaTag(html, 'name', 'twitter:image')
    );

    return {
      title: title || null,
      description: description || null,
      thumbnailUrl: image,
    };
  },

  _buildAppleMetadataTrack(meta, requestedBy: string | null, source = 'applemusic') {
    const player = this as ApplePlayer;
    const trackName = String(meta?.trackName ?? meta?.name ?? '').trim() || 'Apple Music track';
    const artistName = String(meta?.artistName ?? '').trim() || null;
    const trackViewUrl = String(meta?.trackViewUrl ?? meta?.collectionViewUrl ?? meta?.artistViewUrl ?? '').trim();
    const durationSec = toAppleDurationSeconds(meta?.trackTimeMillis ?? meta?.collectionTimeMillis);

    return player._buildTrack({
      title: trackName,
      url: trackViewUrl || 'https://music.apple.com',
      duration: durationSec ?? 'Unknown',
      thumbnailUrl: normalizeThumbnailUrl(meta?.artworkUrl100 ?? meta?.artworkUrl60 ?? null),
      requestedBy,
      source,
      artist: artistName,
    });
  },

  _buildAppleFallbackTrack(url: string, metadata, requestedBy: string | null, source = 'applemusic-fallback') {
    const title = String(metadata?.title ?? '').trim();
    const description = String(metadata?.description ?? '').trim();
    let artist = null;
    if (description.includes(' · ')) {
      const parts = description.split(' · ').map((part) => part.trim()).filter(Boolean);
      artist = parts[1] ?? null;
    }

    return {
      title: title || 'Apple Music track',
      artist,
      url,
      thumbnailUrl: metadata?.thumbnailUrl ?? null,
      requestedBy,
      source,
    };
  },

  async _resolveAppleFallbackSearch(url: string, requestedBy: string | null) {
    const methods = this as AppleMethods & ApplePlayer;
    const pageMetadata = await methods._fetchApplePageMetadata(url).catch(() => null);
    const fallbackTrack = methods._buildAppleFallbackTrack(url, pageMetadata, requestedBy);
    const query = methods._pickMirrorSearchQuery(fallbackTrack) || sanitizeUrlToSearchQuery(url);
    if (!query) {
      throw new ValidationError('Could not resolve Apple Music URL to a playable track.');
    }

    if (!this.enableYtSearch) {
      throw new ValidationError('Apple Music mirroring requires YouTube search, which is currently disabled.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('Apple Music mirroring requires YouTube playback, which is currently disabled.');
    }

    const results = await methods._searchYouTubeTracks(query, 1, requestedBy).catch(() => []);
    if (!results.length) {
      throw new ValidationError('Could not resolve Apple Music URL to a playable track.');
    }

    return [methods._cloneTrack(results[0]!, {
      source: 'applemusic-fallback',
      requestedBy,
    })];
  },

  async _resolveAppleMirror(metadataTrack, requestedBy) {
    const methods = this as AppleMethods & ApplePlayer;
    const query = methods._pickMirrorSearchQuery(metadataTrack);
    if (!query) {
      throw new ValidationError('Could not build Apple Music mirror search query.');
    }

    if (this.deezerArl && this.enableDeezerImport) {
      const deezerMatches = await methods._searchDeezerTracks(query, 3, requestedBy).catch(() => []);
      const deezerBest = methods._pickBestSpotifyMirror(metadataTrack, deezerMatches);
      if (deezerBest) {
        return [methods._cloneTrack(deezerBest, {
          source: `applemusic-${deezerBest.source ?? 'deezer-search'}`,
          requestedBy,
        })];
      }
    }

    const sourceSeed: CrossSourceSeed = {
      ...(metadataTrack.title ? { title: metadataTrack.title } : {}),
      ...(metadataTrack.artist ? { artist: metadataTrack.artist } : {}),
      durationInSec: typeof metadataTrack.duration === 'number'
        ? metadataTrack.duration
        : toAppleDurationSeconds(metadataTrack.duration),
    };
    return methods._resolveCrossSourceToYouTube([sourceSeed], requestedBy, 'applemusic');
  },

  async _resolveAppleTrack(url, requestedBy) {
    const methods = this as AppleMethods & ApplePlayer;
    const entity = extractAppleMusicEntity(url);
    if (!entity) {
      throw new ValidationError('Could not extract Apple Music track id from URL.');
    }

    const trackId = entity.trackId || ((entity.type === 'song' && /^\d+$/.test(entity.id)) ? entity.id : null);
    if (trackId) {
      const results = await methods._appleLookup({
        id: trackId,
        entity: 'song',
        country: entity.countryCode || 'US',
      }).catch(() => []);
      const match = results.find((item: AppleLookupResult) => String(item?.wrapperType ?? '').toLowerCase() === 'track');
      if (match) {
        const metadataTrack = methods._buildAppleMetadataTrack(match, requestedBy, 'applemusic');
        return methods._resolveAppleMirror(metadataTrack, requestedBy);
      }
    }

    return methods._resolveAppleFallbackSearch(url, requestedBy);
  },

  async _resolveAppleCollection(url, requestedBy, limit = null) {
    const methods = this as AppleMethods & ApplePlayer;
    const entity = extractAppleMusicEntity(url);
    if (!entity) {
      throw new ValidationError('Could not extract Apple Music collection id from URL.');
    }

    if (entity.type === 'playlist') {
      throw new ValidationError('Apple Music playlists are not supported yet. Use a track or album link.');
    }

    const lookupId = entity.trackId || entity.id;
    if (!/^\d+$/.test(String(lookupId ?? ''))) {
      throw new ValidationError('Could not extract numeric Apple Music collection id from URL.');
    }

    const safeLimit = normalizeAppleCollectionLimit(limit, this.maxPlaylistTracks);
    const entityType = entity.type === 'artist' ? 'song' : 'song';
    const results = await methods._appleLookup({
      id: lookupId,
      entity: entityType,
      country: entity.countryCode || 'US',
      limit: safeLimit,
    }).catch(() => []);

    const tracks: Track[] = [];
    for (const item of results) {
      if (String(item?.wrapperType ?? '').toLowerCase() !== 'track') continue;
      const metadataTrack = methods._buildAppleMetadataTrack(item, requestedBy, `applemusic-${entity.type}`);
      try {
        const mirrored = await methods._resolveAppleMirror(metadataTrack, requestedBy);
        tracks.push(...mirrored.slice(0, 1));
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Apple Music track', {
          appleTrackId: item?.trackId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (tracks.length >= safeLimit) break;
    }

    if (tracks.length) return tracks;
    throw new ValidationError('Could not resolve Apple Music collection to playable tracks.');
  },

  async _resolveAppleByGuess(url, requestedBy, limit = null) {
    const methods = this as AppleMethods & ApplePlayer;
    const entity = extractAppleMusicEntity(url);
    if (!entity) {
      return methods._resolveAppleFallbackSearch(url, requestedBy);
    }

    if (entity.trackId || entity.type === 'song') {
      return methods._resolveAppleTrack(url, requestedBy);
    }

    if (entity.type === 'album' || entity.type === 'artist') {
      return methods._resolveAppleCollection(url, requestedBy, limit);
    }

    return methods._resolveAppleFallbackSearch(url, requestedBy);
  },
};


