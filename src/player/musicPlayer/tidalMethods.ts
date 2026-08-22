import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../../core/errors.ts';
import { extractTidalEntity, isHttpUrl, pickThumbnailUrlFromItem } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

const TIDAL_API_BASE = 'https://api.tidal.com/v1/';
const TIDAL_ASSET_URL = 'https://tidal.com/assets/index-CJ0DsMmf.js';
const TIDAL_REQUEST_TIMEOUT_MS = 12_000;
const TIDAL_TOKEN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIDAL_PAGE_SIZE = 50;
const TIDAL_PAGE_CONCURRENCY = 4;
const TIDAL_MIRROR_CONCURRENCY = 4;
const TIDAL_TOKEN_CACHE_PATH = path.join(process.cwd(), '.cache', 'tidal-token.json');

type TidalArtistLike = { name?: unknown };
type TidalAlbumLike = { cover?: unknown; imageCover?: unknown } | null | undefined;
type TidalTrackLike = Record<string, unknown> & {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  artists?: unknown;
  artist?: { name?: unknown } | null;
  album?: TidalAlbumLike;
  url?: unknown;
  isrc?: unknown;
};
type TidalPlaylistLike = Record<string, unknown> & {
  title?: unknown;
};
type TidalPlayer = MusicPlayer & {
  enableTidalImport?: boolean;
  tidalToken?: string | null;
  tidalCountryCode?: string | null;
  _buildTrack: (input: Record<string, unknown>) => Track;
  _cloneTrack: (track: Track, overrides?: Partial<Track>) => Track;
  _pickMirrorSearchQuery: (track: Partial<Track> | null | undefined) => string;
  _searchDeezerTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _pickBestSpotifyMirror: (metadataTrack: Partial<Track> | null | undefined, candidates: unknown) => Track | null;
  _resolveCrossSourceToYouTube: (
    sourceTracks: Array<{ title?: string; artist?: string | null; durationInSec?: number | null }>,
    requestedBy: string | null,
    source: string,
  ) => Promise<Track[]>;
  _parseDurationSeconds?: (value: unknown) => number | null;
  _shouldUseDirectDeezerMirror: () => boolean;
  logger?: { warn?: (message: string, payload?: Record<string, unknown>) => void };
  maxPlaylistTracks: number;
  deezerArl?: string | null;
  enableDeezerImport?: boolean;
  _tidalTokenFetchedAtMs?: number;
};
type TidalMethods = {
  _getTidalToken(): Promise<string>;
  _tidalApiRequest(endpoint: string, params?: Record<string, unknown>): Promise<unknown>;
  _buildTidalMetadataTrack(track: TidalTrackLike | null | undefined, requestedBy: string | null, source?: string): Track;
  _resolveTidalMirror(metadataTrack: Track, requestedBy: string | null): Promise<Track[]>;
  _resolveTidalTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveTidalCollection(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveTidalMix(id: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveTidalByGuess(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
};
type TidalRuntime = TidalPlayer & TidalMethods;

function normalizeTidalCollectionLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

function parseTidalArtists(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String((entry as TidalArtistLike | null | undefined)?.name ?? '').trim())
    .filter(Boolean);
}

function buildTidalArtworkUrl(album: TidalAlbumLike) {
  const cover = String(album?.cover ?? album?.imageCover ?? '').trim();
  if (!cover) return null;
  return `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/1280x1280.jpg`;
}

function extractSecondClientId(text: string) {
  const re = /clientId\s*[:=]\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(text))) {
    if (++count === 2) return String(match[1] ?? '').trim() || null;
  }
  return null;
}

function asTrackItem(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return (record.item ?? record) as TidalTrackLike;
}

async function readCachedTidalToken() {
  const raw = await readFile(TIDAL_TOKEN_CACHE_PATH, 'utf8').catch(() => null);
  if (!raw) return null;

  try {
    const payload = JSON.parse(raw) as { token?: unknown; fetchedAt?: unknown } | null;
    const token = String(payload?.token ?? '').trim();
    const fetchedAt = Number.parseInt(String(payload?.fetchedAt ?? ''), 10);
    if (!token || !Number.isFinite(fetchedAt) || (Date.now() - fetchedAt) > TIDAL_TOKEN_CACHE_TTL_MS) {
      return null;
    }
    return { token, fetchedAt };
  } catch {
    return null;
  }
}

async function writeCachedTidalToken(token: string) {
  await mkdir(path.dirname(TIDAL_TOKEN_CACHE_PATH), { recursive: true }).catch(() => {});
  await writeFile(TIDAL_TOKEN_CACHE_PATH, JSON.stringify({
    token,
    fetchedAt: Date.now(),
  }), 'utf8').catch(() => {});
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
) {
  const results: TOutput[] = [];
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, concurrency));
  let cursor = 0;

  await Promise.all(Array.from({ length: safeConcurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!, index);
    }
  }));

  return results;
}

export const tidalMethods: TidalMethods & ThisType<TidalPlayer> = {
  async _getTidalToken(this: TidalRuntime) {
    const configured = String(this.tidalToken ?? '').trim();
    if (configured) return configured;

    const cached = await readCachedTidalToken();
    if (cached?.token) {
      this.tidalToken = cached.token;
      this._tidalTokenFetchedAtMs = cached.fetchedAt;
      return cached.token;
    }

    const response = await fetch(TIDAL_ASSET_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(TIDAL_REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`Tidal token bootstrap failed (${response?.status ?? 'network'})`);
    }

    const token = extractSecondClientId(await response.text().catch(() => ''));
    if (!token) {
      throw new Error('Could not extract Tidal client token from bootstrap asset.');
    }

    this.tidalToken = token;
    this._tidalTokenFetchedAtMs = Date.now();
    await writeCachedTidalToken(token);
    return token;
  },

  async _tidalApiRequest(this: TidalRuntime, endpoint: string, params: Record<string, unknown> = {}) {
    const token = await this._getTidalToken();
    const url = new URL(String(endpoint ?? '').replace(/^\/+/, ''), TIDAL_API_BASE);
    const countryCode = String(this.tidalCountryCode ?? 'US').trim().toUpperCase() || 'US';
    url.searchParams.set('countryCode', countryCode);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-tidal-token': token,
        'User-Agent': 'TIDAL/3704 CFNetwork/1220.1 Darwin/20.3.0',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIDAL_REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`Failed to fetch from Tidal API (${response?.status ?? 'network'}): ${url.pathname}`);
    }
    return response.json().catch(() => null);
  },

  _buildTidalMetadataTrack(this: TidalRuntime, track, requestedBy: string | null, source = 'tidal') {
    const artists = parseTidalArtists(track?.artists);
    const fallbackArtist = String(track?.artist?.name ?? '').trim();
    const artist = artists.join(', ') || fallbackArtist || null;
    const id = String(track?.id ?? '').trim();
    const rawUrl = String(track?.url ?? '').trim();
    const tidalUrl = isHttpUrl(rawUrl)
      ? rawUrl
      : `https://tidal.com/browse/track/${encodeURIComponent(id || 'unknown')}`;

    return this._buildTrack({
      title: String(track?.title ?? 'Tidal track').trim() || 'Tidal track',
      url: tidalUrl,
      duration: track?.duration ?? 'Unknown',
      thumbnailUrl: buildTidalArtworkUrl(track?.album) ?? pickThumbnailUrlFromItem(track?.album ?? track),
      requestedBy,
      source,
      artist,
      isrc: String(track?.isrc ?? '').trim() || null,
    });
  },

  async _resolveTidalMirror(this: TidalRuntime, metadataTrack, requestedBy: string | null) {
    const query = this._pickMirrorSearchQuery(metadataTrack);
    if (!query) {
      throw new ValidationError('Could not build Tidal mirror search query.');
    }

    const durationInSec = this._parseDurationSeconds?.(metadataTrack.duration) ?? null;
    if (this._shouldUseDirectDeezerMirror()) {
      const deezerMatches = await this._searchDeezerTracks(query, 3, requestedBy).catch(() => []);
      const deezerBest = this._pickBestSpotifyMirror(metadataTrack, deezerMatches);
      if (deezerBest) {
        return [this._cloneTrack(deezerBest, {
          source: `tidal-${deezerBest.source ?? 'deezer-search'}`,
          requestedBy,
        })];
      }
    }

    return this._resolveCrossSourceToYouTube([{
      title: metadataTrack.title,
      artist: metadataTrack.artist,
      durationInSec,
      isrc: metadataTrack.isrc,
    }], requestedBy, 'tidal');
  },

  async _resolveTidalTrack(this: TidalRuntime, url: string, requestedBy: string | null) {
    if (!this.enableTidalImport) {
      throw new ValidationError('Tidal import is currently disabled by bot configuration.');
    }

    const entity = extractTidalEntity(url);
    if (!entity || entity.type !== 'track') {
      throw new ValidationError('Could not extract Tidal track id from URL.');
    }

    const payload = await this._tidalApiRequest(`/tracks/${encodeURIComponent(entity.id)}`) as TidalTrackLike | null;
    if (!payload?.id) {
      throw new ValidationError('Could not fetch Tidal track metadata.');
    }

    const metadataTrack = this._buildTidalMetadataTrack(payload, requestedBy, 'tidal');
    return this._resolveTidalMirror(metadataTrack, requestedBy);
  },

  async _resolveTidalCollection(this: TidalRuntime, url: string, requestedBy: string | null, limit?: number | null) {
    if (!this.enableTidalImport) {
      throw new ValidationError('Tidal import is currently disabled by bot configuration.');
    }

    const entity = extractTidalEntity(url);
    if (!entity || (entity.type !== 'album' && entity.type !== 'playlist')) {
      throw new ValidationError('Could not extract Tidal album/playlist id from URL.');
    }

    const safeLimit = normalizeTidalCollectionLimit(limit, this.maxPlaylistTracks);
    const infoEndpoint = entity.type === 'album'
      ? `/albums/${encodeURIComponent(entity.id)}`
      : `/playlists/${encodeURIComponent(entity.id)}`;
    const tracksEndpoint = entity.type === 'album'
      ? `/albums/${encodeURIComponent(entity.id)}/tracks`
      : `/playlists/${encodeURIComponent(entity.id)}/tracks`;

    const infoPayload = await this._tidalApiRequest(infoEndpoint).catch(() => null) as TidalPlaylistLike | null;
    const pageOffsets = Array.from({ length: Math.ceil(safeLimit / TIDAL_PAGE_SIZE) }, (_, index) => index * TIDAL_PAGE_SIZE);
    const pageResults = await mapWithConcurrency(pageOffsets, TIDAL_PAGE_CONCURRENCY, async (offset) => (
      this._tidalApiRequest(tracksEndpoint, {
        limit: Math.min(TIDAL_PAGE_SIZE, safeLimit - offset),
        offset,
      }).catch(() => null) as Promise<{ items?: unknown[] } | null>
    ));
    const items = pageResults
      .flatMap((payload) => Array.isArray(payload?.items) ? payload.items : [])
      .map((item) => asTrackItem(item))
      .filter(Boolean) as TidalTrackLike[];

    const mirrored = await mapWithConcurrency(items.slice(0, safeLimit), TIDAL_MIRROR_CONCURRENCY, async (item) => {
      const metadataTrack = this._buildTidalMetadataTrack(item, requestedBy, `tidal-${entity.type}`);
      try {
        const resolvedTrack = await this._resolveTidalMirror(metadataTrack, requestedBy);
        return resolvedTrack[0] ?? null;
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Tidal collection track', {
          tidalId: String(item?.id ?? '').trim() || null,
          collection: String(infoPayload?.title ?? entity.id),
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    });
    const resolved = mirrored.filter(Boolean) as Track[];

    if (resolved.length) return resolved;
    throw new ValidationError(`Could not resolve Tidal ${entity.type} to playable tracks.`);
  },

  async _resolveTidalMix(this: TidalRuntime, id: string, requestedBy: string | null, limit?: number | null) {
    if (!this.enableTidalImport) {
      throw new ValidationError('Tidal import is currently disabled by bot configuration.');
    }

    const safeLimit = normalizeTidalCollectionLimit(limit, this.maxPlaylistTracks);
    const payload = await this._tidalApiRequest(`/mixes/${encodeURIComponent(id)}/items`, {
      limit: safeLimit,
    }).catch(() => null) as { items?: unknown[] } | null;
    const items = Array.isArray(payload?.items)
      ? payload!.items!.map((item) => asTrackItem(item)).filter(Boolean) as TidalTrackLike[]
      : [];

    const mirrored = await mapWithConcurrency(items.slice(0, safeLimit), TIDAL_MIRROR_CONCURRENCY, async (item) => {
      const metadataTrack = this._buildTidalMetadataTrack(item, requestedBy, 'tidal-mix');
      try {
        const resolvedTrack = await this._resolveTidalMirror(metadataTrack, requestedBy);
        return resolvedTrack[0] ?? null;
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Tidal mix track', {
          tidalId: String(item?.id ?? '').trim() || null,
          mixId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    });
    const resolved = mirrored.filter(Boolean) as Track[];

    if (resolved.length) return resolved;
    throw new ValidationError('Could not resolve Tidal mix to playable tracks.');
  },

  async _resolveTidalByGuess(this: TidalRuntime, url: string, requestedBy: string | null, limit?: number | null) {
    const entity = extractTidalEntity(url);
    if (!entity) {
      throw new ValidationError('Could not extract Tidal entity from URL.');
    }

    if (entity.type === 'track') {
      return this._resolveTidalTrack(url, requestedBy);
    }
    if (entity.type === 'mix') {
      return this._resolveTidalMix(entity.id, requestedBy, limit);
    }
    return this._resolveTidalCollection(url, requestedBy, limit);
  },
};
