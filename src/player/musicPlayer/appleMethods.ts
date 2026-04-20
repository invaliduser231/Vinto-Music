import { ValidationError } from '../../core/errors.ts';
import {
  extractAppleMusicEntity,
  normalizeThumbnailUrl,
  sanitizeUrlToSearchQuery,
} from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

const ITUNES_LOOKUP_BASE = 'https://itunes.apple.com/lookup';
const APPLE_CATALOG_API_BASE = 'https://api.music.apple.com/v1';
const APPLE_WEB_TOKEN_PAGE = 'https://music.apple.com/us/browse';
const APPLE_PAGE_TIMEOUT_MS = 10_000;
const APPLE_CATALOG_PAGE_SIZE = 300;
const APPLE_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

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
  isrc?: string | null;
};
type CrossSourceSeed = {
  title?: string;
  artist?: string | null;
  durationInSec?: number | null;
  isrc?: string | null;
};
type AppleCatalogArtwork = {
  url?: unknown;
};
type AppleCatalogAttributes = {
  name?: unknown;
  artistName?: unknown;
  durationInMillis?: unknown;
  url?: unknown;
  isrc?: unknown;
  artwork?: AppleCatalogArtwork | null;
};
type AppleCatalogRelationship = {
  data?: unknown;
  meta?: {
    total?: unknown;
  } | null;
};
type AppleCatalogItem = {
  id?: unknown;
  type?: unknown;
  attributes?: AppleCatalogAttributes | null;
  relationships?: {
    tracks?: AppleCatalogRelationship | null;
  } | null;
};
type AppleCatalogResponse = {
  data?: unknown;
  next?: unknown;
};
type AppleMusicEntity = NonNullable<ReturnType<typeof extractAppleMusicEntity>>;
type AppleMusicToken = {
  token: string;
  origin: string | null;
  expiresAtMs: number;
};
type ApplePlayer = MusicPlayer & {
  appleMusicMediaApiToken?: string | null;
  appleMusicAutoToken?: boolean;
  appleMusicMarket?: string;
  appleMusicTokenOrigin?: string | null;
  _appleMusicMediaApiTokenExpiresAtMs?: number;
  _appleMusicMediaApiTokenFetchedAtMs?: number;
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
  _fetchAppleMusicMediaApiToken(): Promise<AppleMusicToken | null>;
  _ensureAppleMusicMediaApiToken(): Promise<string | null>;
  _appleCatalogRequest(path: string, retry?: boolean): Promise<AppleCatalogResponse | null>;
  _buildAppleCatalogTrack(item: AppleCatalogItem | null | undefined, requestedBy: string | null, source?: string): Track | null;
  _resolveAppleCatalogTrack(entity: AppleMusicEntity, requestedBy: string | null): Promise<Track[] | null>;
  _resolveAppleCatalogCollection(entity: AppleMusicEntity, requestedBy: string | null, limit?: number | null): Promise<Track[] | null>;
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

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function toCatalogItems(value: unknown): AppleCatalogItem[] {
  return toArray(value).filter((item): item is AppleCatalogItem => Boolean(toRecord(item)));
}

function normalizeAppleMarket(value: unknown, fallback = 'US') {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : fallback;
}

function normalizeAppleTokenOrigin(value: unknown) {
  const origin = String(value ?? '').trim();
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    return parsed.origin;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');
  if (!payload) return null;

  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJwt(value: unknown) {
  return String(value ?? '').match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/)?.[0] ?? null;
}

function extractAppleModuleScript(html: string) {
  const moduleMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["'][^>]*>/i);
  const fallbackMatch = html.match(/<script[^>]+src=["']([^"']+\/assets\/[^"']+\.js[^"']*)["'][^>]*>/i);
  const scriptPath = moduleMatch?.[1] ?? fallbackMatch?.[1] ?? null;
  if (!scriptPath) return null;

  try {
    return new URL(scriptPath, APPLE_WEB_TOKEN_PAGE).toString();
  } catch {
    return null;
  }
}

function normalizeAppleArtworkUrl(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return normalizeThumbnailUrl(raw.replace(/\{w\}/g, '512').replace(/\{h\}/g, '512'));
}

function appleCatalogPath(entity: AppleMusicEntity, suffix = '') {
  const country = normalizeAppleMarket(entity.countryCode, 'US').toLowerCase();
  const catalogType = entity.type === 'playlist' ? 'playlists'
    : entity.type === 'artist' ? 'artists'
      : entity.type === 'song' ? 'songs'
        : 'albums';
  return `/catalog/${country}/${catalogType}/${encodeURIComponent(entity.id)}${suffix}`;
}

function trackItemType(value: unknown) {
  return String((value as AppleCatalogItem | null | undefined)?.type ?? '').toLowerCase();
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

  async _fetchAppleMusicMediaApiToken() {
    const pageResponse = await fetch(APPLE_WEB_TOKEN_PAGE, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(APPLE_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!pageResponse?.ok) return null;

    const html = await pageResponse.text().catch(() => '');
    const scriptUrl = extractAppleModuleScript(html);
    if (!scriptUrl) return null;

    const scriptResponse = await fetch(scriptUrl, {
      method: 'GET',
      headers: {
        accept: 'application/javascript,text/javascript,*/*',
      },
      signal: AbortSignal.timeout(APPLE_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!scriptResponse?.ok) return null;

    const script = await scriptResponse.text().catch(() => '');
    const token = extractJwt(script);
    if (!token) return null;

    const payload = decodeJwtPayload(token);
    const exp = Number.parseInt(String(payload?.exp ?? ''), 10);
    const expiresAtMs = Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 60 * 60_000;
    const origin = normalizeAppleTokenOrigin(payload?.root_https_origin) ?? new URL(APPLE_WEB_TOKEN_PAGE).origin;
    return { token, origin, expiresAtMs };
  },

  async _ensureAppleMusicMediaApiToken() {
    const methods = this as AppleMethods & ApplePlayer;
    const player = this as ApplePlayer;
    const nowMs = Date.now();
    const configured = String(player.appleMusicMediaApiToken ?? '').trim();
    if (configured) return configured;

    if (player.appleMusicAutoToken === false) return null;
    if (
      player.appleMusicMediaApiToken
      && Number(player._appleMusicMediaApiTokenExpiresAtMs ?? 0) > nowMs + APPLE_TOKEN_REFRESH_SKEW_MS
    ) {
      return player.appleMusicMediaApiToken;
    }

    const token = await methods._fetchAppleMusicMediaApiToken().catch(() => null);
    if (!token?.token) return null;

    player.appleMusicMediaApiToken = token.token;
    player.appleMusicTokenOrigin = token.origin;
    player._appleMusicMediaApiTokenExpiresAtMs = token.expiresAtMs;
    player._appleMusicMediaApiTokenFetchedAtMs = nowMs;
    return token.token;
  },

  async _appleCatalogRequest(path, retry = true) {
    const methods = this as AppleMethods & ApplePlayer;
    const player = this as ApplePlayer;
    const token = await methods._ensureAppleMusicMediaApiToken();
    if (!token) return null;

    const endpoint = path.startsWith('http')
      ? new URL(path)
      : new URL(`${APPLE_CATALOG_API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };
    if (player.appleMusicTokenOrigin) headers.origin = player.appleMusicTokenOrigin;

    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(APPLE_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (response?.status === 401 && retry) {
      player.appleMusicMediaApiToken = null;
      player._appleMusicMediaApiTokenExpiresAtMs = 0;
      return methods._appleCatalogRequest(path, false);
    }

    if (!response?.ok) return null;
    return await response.json().catch(() => null) as AppleCatalogResponse | null;
  },

  _buildAppleCatalogTrack(item, requestedBy, source = 'applemusic') {
    const player = this as ApplePlayer;
    const attributes = item?.attributes ?? null;
    const title = String(attributes?.name ?? '').trim();
    if (!title) return null;

    const artist = String(attributes?.artistName ?? '').trim() || null;
    const durationSec = toAppleDurationSeconds(attributes?.durationInMillis);
    const url = String(attributes?.url ?? '').trim() || 'https://music.apple.com';
    const isrc = String(attributes?.isrc ?? '').trim().toUpperCase() || null;

    return player._buildTrack({
      title,
      url,
      duration: durationSec ?? 'Unknown',
      thumbnailUrl: normalizeAppleArtworkUrl(attributes?.artwork?.url),
      requestedBy,
      source,
      artist,
      ...(isrc ? { isrc } : {}),
    });
  },

  async _resolveAppleCatalogTrack(entity, requestedBy) {
    const methods = this as AppleMethods & ApplePlayer;
    const trackId = entity.trackId || entity.id;
    if (!trackId) return null;

    const country = normalizeAppleMarket(entity.countryCode ?? methods.appleMusicMarket, 'US').toLowerCase();
    const payload = await methods._appleCatalogRequest(
      `/catalog/${country}/songs/${encodeURIComponent(trackId)}`
    );
    const item = toCatalogItems(payload?.data)[0] ?? null;
    const metadataTrack = methods._buildAppleCatalogTrack(item, requestedBy, 'applemusic');
    if (!metadataTrack) return null;

    return methods._resolveAppleMirror(metadataTrack, requestedBy);
  },

  async _resolveAppleCatalogCollection(entity, requestedBy, limit = null) {
    const methods = this as AppleMethods & ApplePlayer;
    if (!['album', 'playlist', 'artist'].includes(entity.type)) return null;

    const safeLimit = normalizeAppleCollectionLimit(limit, methods.maxPlaylistTracks);
    const tracks: Track[] = [];
    const appendMirrors = async (items: AppleCatalogItem[], source: string) => {
      for (const item of items) {
        if (trackItemType(item) !== 'songs') continue;

        const metadataTrack = methods._buildAppleCatalogTrack(item, requestedBy, source);
        if (!metadataTrack) continue;

        try {
          const mirrored = await methods._resolveAppleMirror(metadataTrack, requestedBy);
          tracks.push(...mirrored.slice(0, 1));
        } catch (err) {
          methods.logger?.warn?.('Failed to mirror Apple Music catalog track', {
            appleTrackId: item.id ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (tracks.length >= safeLimit) break;
      }
    };

    if (entity.type === 'artist') {
      const payload = await methods._appleCatalogRequest(`${appleCatalogPath(entity, '/view/top-songs')}?limit=${safeLimit}`);
      await appendMirrors(toCatalogItems(payload?.data), 'applemusic-artist');
      return tracks.length ? tracks : null;
    }

    const collectionPayload = await methods._appleCatalogRequest(`${appleCatalogPath(entity)}?extend=artistUrl`);
    const collectionItem = toCatalogItems(collectionPayload?.data)[0] ?? null;
    const relatedTracks = toCatalogItems(collectionItem?.relationships?.tracks?.data);
    await appendMirrors(relatedTracks.slice(0, safeLimit), `applemusic-${entity.type}`);

    const total = Number.parseInt(String(collectionItem?.relationships?.tracks?.meta?.total ?? ''), 10);
    for (
      let offset = relatedTracks.length;
      tracks.length < safeLimit && Number.isFinite(total) && offset < total;
      offset += APPLE_CATALOG_PAGE_SIZE
    ) {
      const remaining = safeLimit - tracks.length;
      const pageLimit = Math.min(APPLE_CATALOG_PAGE_SIZE, remaining);
      const pagePayload = await methods._appleCatalogRequest(
        `${appleCatalogPath(entity, '/tracks')}?limit=${pageLimit}&offset=${offset}&extend=artistUrl`
      );
      const pageTracks = toCatalogItems(pagePayload?.data);
      if (!pageTracks.length) break;
      await appendMirrors(pageTracks, `applemusic-${entity.type}`);
    }

    return tracks.length ? tracks : null;
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
      isrc: String(meta?.isrc ?? '').trim().toUpperCase() || null,
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
      ...(metadataTrack.isrc ? { isrc: metadataTrack.isrc } : {}),
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
    const catalogResult = await methods._resolveAppleCatalogTrack(entity, requestedBy).catch(() => null);
    if (catalogResult?.length) return catalogResult;

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

    const lookupId = entity.trackId || entity.id;
    const catalogResult = await methods._resolveAppleCatalogCollection(entity, requestedBy, limit).catch(() => null);
    if (catalogResult?.length) return catalogResult;

    if (entity.type === 'playlist') {
      throw new ValidationError('Apple Music playlists require Apple Music Catalog access.');
    }

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

    const isSingleTrackPreview = Number.parseInt(String(limit ?? ''), 10) === 1;
    if (entity.type === 'song' || (entity.trackId && isSingleTrackPreview)) {
      return methods._resolveAppleTrack(url, requestedBy);
    }

    if (entity.type === 'album' || entity.type === 'artist' || entity.type === 'playlist') {
      return methods._resolveAppleCollection(url, requestedBy, limit);
    }

    return methods._resolveAppleFallbackSearch(url, requestedBy);
  },
};


