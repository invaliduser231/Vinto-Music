import { ValidationError } from '../../core/errors.ts';
import {
  extractAmazonMusicEntity,
  normalizeThumbnailUrl,
  sanitizeUrlToSearchQuery,
} from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

const AMAZON_PAGE_TIMEOUT_MS = 10_000;

type AmazonArtistLike = {
  name?: unknown;
  title?: unknown;
  artist?: unknown;
  byArtist?: { name?: unknown } | null;
  author?: { name?: unknown } | null;
  creator?: { name?: unknown } | null;
} & Record<string, unknown>;
type AmazonStructuredTrack = {
  title: string;
  artist: string | null;
  durationInSec: number | null;
  url: string;
  thumbnailUrl: string | null;
};
type AmazonStructuredItem = {
  name?: unknown;
  title?: unknown;
  byArtist?: unknown;
  artist?: unknown;
  author?: unknown;
  creator?: unknown;
  duration?: unknown;
  durationInSeconds?: unknown;
  url?: unknown;
  image?: { url?: unknown } | unknown;
  thumbnailUrl?: unknown;
} & Record<string, unknown>;
type AmazonLookupArtist = { name?: unknown } | null;
type AmazonLookupAlbumImage = { image?: unknown } | null;
type AmazonLookupTrack = {
  asin?: unknown;
  title?: unknown;
  duration?: unknown;
  image?: unknown;
  album?: AmazonLookupAlbumImage;
  primaryArtistName?: unknown;
  artist?: AmazonLookupArtist;
} & Record<string, unknown>;
type AmazonLookupAlbum = {
  asin?: unknown;
  title?: unknown;
  duration?: unknown;
  image?: unknown;
  primaryArtistName?: unknown;
  artist?: AmazonLookupArtist;
} & Record<string, unknown>;
type AmazonStructuredNode = {
  ['@type']?: unknown;
  item?: unknown;
  track?: unknown;
  tracks?: unknown;
  itemListElement?: unknown;
  [key: string]: unknown;
};
type AmazonPageMetadata = {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  tracks: AmazonStructuredTrack[];
};
type AmazonFallbackMetadata = {
  title?: unknown;
  description?: unknown;
  thumbnailUrl?: unknown;
} | null;
type AmazonLookupConfig = {
  origin: string;
  siteRegion: string;
  marketplaceId: string;
  musicTerritory: string | null;
  deviceType: string;
  deviceId: string;
  customerId: string;
  csrf: {
    token: string;
    rnd: string;
    ts: string;
  };
};
type AmazonConfigPayload = {
  marketplaceId?: unknown;
  deviceType?: unknown;
  deviceId?: unknown;
  siteRegion?: unknown;
  musicTerritory?: unknown;
  customerId?: unknown;
  csrf?: {
    token?: unknown;
    rnd?: unknown;
    ts?: unknown;
  } | null;
} | null;
type AmazonLegacyLookupPayload = {
  trackList?: AmazonLookupTrack[];
  albumList?: AmazonLookupAlbum[];
} | null;
type AmazonMetadataInput = Partial<AmazonStructuredTrack> & {
  name?: unknown;
  duration?: unknown;
  durationInSec?: number | string | null;
  thumbnailUrl?: unknown;
  artist?: unknown;
  title?: unknown;
  url?: unknown;
};
type AmazonPlayer = MusicPlayer & {
  _amazonLookupConfigCache?: Map<string, AmazonLookupConfig>;
  maxPlaylistTracks: number;
  enableDeezerImport?: boolean;
  enableYtSearch?: boolean;
  enableYtPlayback?: boolean;
  deezerArl?: string | null;
  logger?: { warn?: (message: string, payload?: Record<string, unknown>) => void };
  _buildTrack: (input: Record<string, unknown>) => Track;
  _buildDeezerTrackFromMetadata: (meta: unknown, requestedBy: string | null, source?: string) => Track | null;
  _deezerApiRequest: (path: string) => Promise<{ data?: unknown } | null>;
  _pickMirrorSearchQuery: (track: Partial<Track> & { durationInSec?: number | null }) => string | null;
  _searchYouTubeTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _resolveNodeLinkTracks: (query: string, requestedBy: string | null, limit?: number | null) => Promise<Track[]>;
  _cloneTrack: (track: Track, overrides?: Partial<Track>) => Track;
  _searchDeezerTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _pickBestSpotifyMirror: (metadataTrack: Partial<Track>, candidates: unknown) => Track | null;
  _resolveCrossSourceToYouTube: (sourceTracks: Array<{ title?: string; artist?: string | null; durationInSec?: number | null }>, requestedBy: string | null, source: string) => Promise<Track[]>;
  nodeLinkEnabled?: boolean;
  nodeLinkClient?: { enabled?: boolean } | null;
  nodeLinkRoutingMode?: string | null;
};
type AmazonMethods = {
  _getAmazonLookupConfig(url: string): Promise<AmazonLookupConfig>;
  _amazonLegacyLookup(url: string, asins: unknown, requestedContent?: string): Promise<AmazonLegacyLookupPayload>;
  _buildAmazonLookupTrack(track: AmazonLookupTrack | null | undefined, url: string, requestedBy: string | null, source?: string): Track;
  _buildAmazonLookupAlbum(album: AmazonLookupAlbum | null | undefined, url: string, requestedBy: string | null, source?: string): Track;
  _searchDeezerAlbumMirrorTracks(artist: unknown, album: unknown, limit: unknown, requestedBy: string | null): Promise<Track[]>;
  _fetchAmazonPageMetadata(url: string): Promise<AmazonPageMetadata | null>;
  _buildAmazonMetadataTrack(meta: AmazonMetadataInput | null | undefined, requestedBy: string | null, source?: string): Track;
  _resolveAmazonFallbackSearch(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveAmazonMirror(metadataTrack: Partial<Track> & { durationInSec?: number | null }, requestedBy: string | null): Promise<Track[]>;
  _resolveAmazonTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveAmazonCollection(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveAmazonByGuess(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
};
type AmazonRuntime = AmazonPlayer & AmazonMethods;

function toAmazonDurationNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pickAmazonOrigin(url: unknown) {
  try {
    return new URL(String(url ?? '')).origin;
  } catch {
    return 'https://music.amazon.com';
  }
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
  const patterns = [
    new RegExp(
      `<meta[^>]+${attribute}=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${name}["'][^>]*>`,
      'i'
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const content = match?.[1];
    if (content) return content;
  }
  return null;
}

function stripAmazonSuffix(value: unknown) {
  return String(value ?? '')
    .replace(/\s*(?:on\s+)?Amazon\s+Music(?:[:\-|].*)?$/i, '')
    .replace(/\s*-\s*Amazon(?:\.[A-Za-z.]+)?$/i, '')
    .trim();
}

function toArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseIsoDurationToSeconds(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const match = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const hours = Number.parseInt(match[1] ?? '0', 10) || 0;
  const minutes = Number.parseInt(match[2] ?? '0', 10) || 0;
  const seconds = Number.parseInt(match[3] ?? '0', 10) || 0;
  const total = (hours * 3600) + (minutes * 60) + seconds;
  return total > 0 ? total : null;
}

function normalizeAmazonCollectionLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

function pickArtist(value: unknown): string | null {
  if (Array.isArray(value)) {
    const names = value
      .map((entry) => pickArtist(entry))
      .filter(Boolean);
    return names.join(', ') || null;
  }

  if (!value || typeof value !== 'object') {
    const raw = String(value ?? '').trim();
    return raw || null;
  }

  const typedValue = value as AmazonArtistLike;

  const candidates = [
    typedValue.name,
    typedValue.title,
    typedValue.artist,
    typedValue.byArtist?.name,
    typedValue.author?.name,
    typedValue.creator?.name,
  ];

  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim();
    if (raw) return raw;
  }

  return null;
}

function normalizeAmazonStructuredTrack(entry: unknown, fallbackUrl: string, fallbackImage: string | null): AmazonStructuredTrack | null {
  const typedEntry = entry && typeof entry === 'object' ? entry as AmazonStructuredNode : null;
  const item = typedEntry?.item && typeof typedEntry.item === 'object' ? typedEntry.item : entry;
  if (!item || typeof item !== 'object') return null;
  const typedItem = item as AmazonStructuredItem;

  const title = String(typedItem.name ?? typedItem.title ?? '').trim();
  if (!title) return null;

  const artist = pickArtist(typedItem.byArtist ?? typedItem.artist ?? typedItem.author ?? typedItem.creator);
  const durationInSec = parseIsoDurationToSeconds(typedItem.duration ?? typedItem.durationInSeconds);
  const url = String(typedItem.url ?? fallbackUrl ?? '').trim() || fallbackUrl;
  const image = normalizeThumbnailUrl(
    (typedItem.image && typeof typedItem.image === 'object' ? (typedItem.image as { url?: unknown }).url : undefined)
      ?? typedItem.image
      ?? typedItem.thumbnailUrl
      ?? fallbackImage
  );

  return {
    title,
    artist,
    durationInSec,
    url: url || fallbackUrl,
    thumbnailUrl: image,
  };
}

function collectAmazonStructuredTracks(node: unknown, fallbackUrl: string, fallbackImage: string | null, sink: AmazonStructuredTrack[]) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const entry of node) collectAmazonStructuredTracks(entry, fallbackUrl, fallbackImage, sink);
    return;
  }

  if (typeof node !== 'object') return;
  const typedNode = node as AmazonStructuredNode;

  const type = String(typedNode['@type'] ?? '').trim().toLowerCase();
  if (type === 'musicrecording') {
    const track = normalizeAmazonStructuredTrack(node, fallbackUrl, fallbackImage);
    if (track) sink.push(track);
  }

  if (type === 'musicalbum' || type === 'musicplaylist' || type === 'itemlist') {
    collectAmazonStructuredTracks(typedNode.track, fallbackUrl, fallbackImage, sink);
    collectAmazonStructuredTracks(typedNode.tracks, fallbackUrl, fallbackImage, sink);
    collectAmazonStructuredTracks(typedNode.itemListElement, fallbackUrl, fallbackImage, sink);
  }

  if (typedNode.item) {
    collectAmazonStructuredTracks(typedNode.item, fallbackUrl, fallbackImage, sink);
  }
}

function dedupeTracks(tracks: AmazonStructuredTrack[]) {
  const seen = new Set();
  const result: AmazonStructuredTrack[] = [];
  for (const track of tracks) {
    const key = `${String(track?.artist ?? '').toLowerCase()}::${String(track?.title ?? '').toLowerCase()}`;
    if (!track?.title || seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }
  return result;
}

function isLikelySameAlbum(left: unknown, right: unknown) {
  const a = String(left ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const b = String(right ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function inferFallbackTrack(url: string, metadata: AmazonFallbackMetadata) {
  const title = stripAmazonSuffix(metadata?.title ?? '');
  const description = decodeHtmlEntities(metadata?.description ?? '');
  const thumbnailUrl = normalizeThumbnailUrl(metadata?.thumbnailUrl ?? null);

  let artist = null;
  const byMatch = title.match(/^(.*?)\s+by\s+(.+)$/i);
  if (byMatch?.[1] && byMatch?.[2]) {
    return {
      ...(byMatch[1].trim() ? { title: byMatch[1].trim() } : {}),
      artist: byMatch[2].trim(),
      url,
      thumbnailUrl,
    };
  }

  const descByMatch = description.match(/by\s+([^|,]+)/i);
  if (descByMatch?.[1]) {
    artist = descByMatch[1].trim();
  }

  return {
    ...(title ? { title } : {}),
    artist,
    url,
    thumbnailUrl,
  };
}

function getNodeLinkRoutingMode(value: unknown): 'smart' | 'all' | 'youtube-only' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'all') return 'all';
  if (normalized === 'youtube-only' || normalized === 'youtube') return 'youtube-only';
  return 'smart';
}

export const amazonMethods: AmazonMethods & ThisType<AmazonPlayer> = {
  async _getAmazonLookupConfig(this: AmazonRuntime, url) {
    const origin = pickAmazonOrigin(url);
    this._amazonLookupConfigCache ??= new Map();
    const cachedConfig = this._amazonLookupConfigCache.get(origin);
    if (cachedConfig) {
      return cachedConfig;
    }

    const endpoint = new URL('/config.json', origin);
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(AMAZON_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Amazon config lookup failed (${response?.status ?? 'network'})`);
    }

    const payload = await response.json?.().catch(() => null) as AmazonConfigPayload;
    if (!payload?.marketplaceId || !payload?.deviceType || !payload?.deviceId || !payload?.siteRegion || !payload?.csrf?.token) {
      throw new Error('Amazon config lookup did not include required fields.');
    }

    const config: AmazonLookupConfig = {
      origin,
      siteRegion: String(payload.siteRegion).trim(),
      marketplaceId: String(payload.marketplaceId).trim(),
      musicTerritory: String(payload.musicTerritory ?? '').trim() || null,
      deviceType: String(payload.deviceType).trim(),
      deviceId: String(payload.deviceId).trim(),
      customerId: String(payload.customerId ?? '').trim() || '',
      csrf: {
        token: String(payload.csrf.token).trim(),
        rnd: String(payload.csrf.rnd ?? '').trim(),
        ts: String(payload.csrf.ts ?? '').trim(),
      },
    };

    this._amazonLookupConfigCache.set(origin, config);
    return config;
  },

  async _amazonLegacyLookup(this: AmazonRuntime, url, asins, requestedContent = 'FULL_CATALOG') {
    const config = await this._getAmazonLookupConfig(url);
    const safeAsins = toArray(asins).map((asin) => String(asin ?? '').trim()).filter(Boolean);
    if (!safeAsins.length) {
      throw new ValidationError('Could not extract a valid Amazon Music ASIN.');
    }

    const endpoint = new URL(`/${encodeURIComponent(config.siteRegion)}/api/muse/legacy/lookup`, config.origin);
    const body = {
      asins: safeAsins,
      requestedContent,
      marketplaceId: config.marketplaceId,
      deviceType: config.deviceType,
      deviceId: config.deviceId,
      customerId: config.customerId,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'csrf-token': config.csrf.token,
        ...(config.csrf.rnd ? { 'csrf-rnd': config.csrf.rnd } : {}),
        ...(config.csrf.ts ? { 'csrf-ts': config.csrf.ts } : {}),
        origin: config.origin,
        referer: `${config.origin}/`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AMAZON_PAGE_TIMEOUT_MS),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Amazon lookup failed (${response?.status ?? 'network'})`);
    }

    return response.json?.().catch(() => null) as Promise<AmazonLegacyLookupPayload>;
  },

  _buildAmazonLookupTrack(this: AmazonRuntime, track, url, requestedBy, source = 'amazonmusic') {
    return this._buildTrack({
      title: String(track?.title ?? '').trim() || 'Amazon Music track',
      url,
      duration: Number.parseInt(String(track?.duration ?? ''), 10) || 'Unknown',
      thumbnailUrl: track?.album?.image ?? track?.image ?? null,
      requestedBy,
      source,
      artist: String(track?.primaryArtistName ?? track?.artist?.name ?? '').trim() || null,
    });
  },

  _buildAmazonLookupAlbum(this: AmazonRuntime, album, url, requestedBy, source = 'amazonmusic-album') {
    return this._buildAmazonMetadataTrack({
      ...(String(album?.title ?? '').trim() ? { title: String(album?.title ?? '').trim() } : {}),
      artist: String(album?.primaryArtistName ?? album?.artist?.name ?? '').trim() || null,
      thumbnailUrl: normalizeThumbnailUrl(album?.image ?? null),
      durationInSec: Number.parseInt(String(album?.duration ?? ''), 10) || null,
      url,
    }, requestedBy, source);
  },

  async _searchDeezerAlbumMirrorTracks(this: AmazonRuntime, artist, album, limit, requestedBy) {
    const safeArtist = String(artist ?? '').trim();
    const safeAlbum = String(album ?? '').trim();
    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));
    if (!safeArtist || !safeAlbum || !this.enableDeezerImport) return [];

    const query = `artist:"${safeArtist.replace(/"/g, '')}" album:"${safeAlbum.replace(/"/g, '')}"`;
    const payload = await this._deezerApiRequest(`/search?q=${encodeURIComponent(query)}`).catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const tracks: Track[] = [];
    const seen = new Set();

    for (const item of items) {
      if (tracks.length >= safeLimit) break;
      if (!isLikelySameAlbum(safeAlbum, item?.album?.title)) continue;
      const track = this._buildDeezerTrackFromMetadata(item, requestedBy, 'deezer-search-direct');
      if (!track?.deezerTrackId) continue;
      const key = String(track.deezerTrackId);
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(track);
    }

    return tracks;
  },

  async _fetchAmazonPageMetadata(this: AmazonRuntime, url) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(AMAZON_PAGE_TIMEOUT_MS),
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

    const tracks: AmazonStructuredTrack[] = [];
    const jsonLdPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = jsonLdPattern.exec(html)) !== null) {
      const jsonLd = match[1];
      if (typeof jsonLd !== 'string') {
        continue;
      }
      const payload = parseJson(jsonLd);
      if (payload) {
        collectAmazonStructuredTracks(payload, url, image, tracks);
      }
    }

    return {
      title: title || null,
      description: description || null,
      thumbnailUrl: image,
      tracks: dedupeTracks(tracks),
    };
  },

  _buildAmazonMetadataTrack(this: AmazonRuntime, meta, requestedBy, source = 'amazonmusic') {
    const duration = meta?.durationInSec ?? meta?.duration ?? 'Unknown';
    return this._buildTrack({
      title: String(meta?.title ?? meta?.name ?? '').trim() || 'Amazon Music track',
      url: String(meta?.url ?? 'https://music.amazon.com').trim() || 'https://music.amazon.com',
      duration,
      thumbnailUrl: meta?.thumbnailUrl ?? null,
      requestedBy,
      source,
      artist: String(meta?.artist ?? '').trim() || null,
    });
  },

  async _resolveAmazonFallbackSearch(this: AmazonRuntime, url, requestedBy) {
    const pageMetadata = await this._fetchAmazonPageMetadata(url).catch(() => null);
    const fallbackTrackBase = inferFallbackTrack(url, pageMetadata);
    const fallbackTrack: Partial<Track> = {
      ...(fallbackTrackBase.title ? { title: fallbackTrackBase.title } : {}),
      ...(fallbackTrackBase.artist ? { artist: fallbackTrackBase.artist } : {}),
      ...(fallbackTrackBase.url ? { url: fallbackTrackBase.url } : {}),
      ...(typeof fallbackTrackBase.thumbnailUrl === 'string' || fallbackTrackBase.thumbnailUrl === null
        ? { thumbnailUrl: fallbackTrackBase.thumbnailUrl }
        : {}),
    };
    const query = this._pickMirrorSearchQuery(fallbackTrack) || sanitizeUrlToSearchQuery(url);
    if (!query) {
      throw new ValidationError('Could not resolve Amazon Music URL to a playable track.');
    }

    if (!this.enableYtSearch) {
      throw new ValidationError('Amazon Music mirroring requires YouTube search, which is currently disabled.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('Amazon Music mirroring requires YouTube playback, which is currently disabled.');
    }

    let results = await (
      this.nodeLinkEnabled && this.nodeLinkClient?.enabled && getNodeLinkRoutingMode(this.nodeLinkRoutingMode) !== 'youtube-only'
        ? this._resolveNodeLinkTracks(query, requestedBy, 1)
        : this._searchYouTubeTracks(query, 1, requestedBy)
    ).catch(() => []);
    if (
      !results.length
      && this.nodeLinkEnabled
      && this.nodeLinkClient?.enabled
      && getNodeLinkRoutingMode(this.nodeLinkRoutingMode) !== 'all'
    ) {
      results = await this._searchYouTubeTracks(query, 1, requestedBy).catch(() => []);
    }
    if (!results.length) {
      throw new ValidationError('Could not resolve Amazon Music URL to a playable track.');
    }

    const firstResult = results[0];
    if (!firstResult) {
      throw new ValidationError('Could not resolve Amazon Music URL to a playable track.');
    }

    return [this._cloneTrack(firstResult, {
      source: 'amazonmusic-fallback',
      requestedBy,
    })];
  },

  async _resolveAmazonMirror(this: AmazonRuntime, metadataTrack, requestedBy) {
    const query = this._pickMirrorSearchQuery(metadataTrack);
    if (!query) {
      throw new ValidationError('Could not build Amazon Music mirror search query.');
    }

    if (this.deezerArl && this.enableDeezerImport) {
      const deezerMatches = await this._searchDeezerTracks(query, 3, requestedBy).catch(() => []);
      const deezerBest = this._pickBestSpotifyMirror(metadataTrack, deezerMatches);
      if (deezerBest) {
        return [this._cloneTrack(deezerBest, {
          source: `amazonmusic-${deezerBest.source ?? 'deezer-search'}`,
          requestedBy,
        })];
      }
    }

    const durationInSec = toAmazonDurationNumber(metadataTrack.duration);
    const seed = {
      ...(metadataTrack.title ? { title: metadataTrack.title } : {}),
      ...(metadataTrack.artist ? { artist: metadataTrack.artist } : {}),
      ...(durationInSec != null ? { durationInSec } : {}),
    };
    return this._resolveCrossSourceToYouTube([seed], requestedBy, 'amazonmusic');
  },

  async _resolveAmazonTrack(this: AmazonRuntime, url, requestedBy) {
    const entity = extractAmazonMusicEntity(url);
    const trackAsin = entity?.trackId || (entity?.type === 'track' ? entity.id : null);
    if (trackAsin) {
      const payload = await this._amazonLegacyLookup(url, [trackAsin], 'FULL_CATALOG').catch(() => null);
      const lookupTrack = payload?.trackList?.[0] ?? null;
      if (lookupTrack?.asin) {
        const metadataTrack = this._buildAmazonLookupTrack(lookupTrack, url, requestedBy, 'amazonmusic');
        return this._resolveAmazonMirror(metadataTrack, requestedBy);
      }
    }

    const pageMetadata = await this._fetchAmazonPageMetadata(url).catch(() => null);
    const metadataTrack = pageMetadata?.tracks?.[0]
      ? this._buildAmazonMetadataTrack(pageMetadata.tracks[0], requestedBy, 'amazonmusic')
      : this._buildAmazonMetadataTrack(inferFallbackTrack(url, pageMetadata), requestedBy, 'amazonmusic');

    if (metadataTrack?.title && metadataTrack.title !== 'Amazon Music track') {
      return this._resolveAmazonMirror(metadataTrack, requestedBy);
    }

    return this._resolveAmazonFallbackSearch(url, requestedBy);
  },

  async _resolveAmazonCollection(this: AmazonRuntime, url, requestedBy, limit = null) {
    const safeLimit = normalizeAmazonCollectionLimit(limit, this.maxPlaylistTracks);
    const entity = extractAmazonMusicEntity(url);
    if (entity?.type === 'album' && entity?.id) {
      const payload = await this._amazonLegacyLookup(url, [entity.id], 'FULL_CATALOG').catch(() => null);
      const lookupAlbum = payload?.albumList?.[0] ?? null;
      if (lookupAlbum?.asin) {
        const deezerAlbumTracks = await this._searchDeezerAlbumMirrorTracks(
          lookupAlbum.primaryArtistName ?? lookupAlbum.artist?.name,
          lookupAlbum.title,
          safeLimit,
          requestedBy
        ).catch(() => []);
        if (deezerAlbumTracks.length) {
          return deezerAlbumTracks.map((track: Track) => this._cloneTrack(track, {
            source: `amazonmusic-${track.source ?? 'deezer-search'}`,
            requestedBy,
          }));
        }

        const albumMetadataTrack = this._buildAmazonLookupAlbum(lookupAlbum, url, requestedBy, 'amazonmusic-album');
        const mirroredAlbumTrack = await this._resolveAmazonMirror(albumMetadataTrack, requestedBy).catch(() => []);
        if (mirroredAlbumTrack.length) return mirroredAlbumTrack;
      }
    }

    const pageMetadata = await this._fetchAmazonPageMetadata(url).catch(() => null);
    const sourceTracks = (pageMetadata?.tracks ?? []).slice(0, safeLimit);

    const tracks: Track[] = [];
    for (const item of sourceTracks) {
      const metadataTrack = this._buildAmazonMetadataTrack(item, requestedBy, `amazonmusic-${entity?.type ?? 'collection'}`);
      try {
        const mirrored = await this._resolveAmazonMirror(metadataTrack, requestedBy);
        tracks.push(...mirrored.slice(0, 1));
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Amazon Music track', {
          amazonUrl: url,
          title: item?.title ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (tracks.length >= safeLimit) break;
    }

    if (tracks.length) return tracks;

    return this._resolveAmazonFallbackSearch(url, requestedBy);
  },

  async _resolveAmazonByGuess(this: AmazonRuntime, url, requestedBy, limit = null) {
    const entity = extractAmazonMusicEntity(url);
    if (!entity) {
      return this._resolveAmazonFallbackSearch(url, requestedBy);
    }

    if (entity.trackId || entity.type === 'track') {
      return this._resolveAmazonTrack(url, requestedBy);
    }

    if (entity.type === 'album' || entity.type === 'playlist' || entity.type === 'artist') {
      return this._resolveAmazonCollection(url, requestedBy, limit);
    }

    return this._resolveAmazonTrack(url, requestedBy);
  },
};


