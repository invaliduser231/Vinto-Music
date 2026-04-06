import crypto from 'node:crypto';
import {
  extractAudiomackEntity,
  extractBandcampEntity,
  extractJioSaavnEntity,
  extractMixcloudEntity,
  isHttpUrl,
  normalizeThumbnailUrl,
  pickThumbnailUrlFromItem,
} from './trackUtils.ts';
import { ValidationError } from '../../core/errors.ts';
import type { Track } from '../../types/domain.ts';

const AUDIOMACK_API_BASE = 'https://api.audiomack.com/v1';
const AUDIOMACK_CONSUMER_KEY = 'audiomack-web';
const AUDIOMACK_CONSUMER_SECRET = 'bd8a07e9f23fbe9d808646b730f89b8e';
const JIOSAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';
const JIOSAAVN_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json',
};
const MIRROR_COLLECTION_CONCURRENCY = 4;

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type MirrorRuntime = {
  _buildTrack: (input: Record<string, unknown>) => Track;
  _cloneTrack: (track: Track, overrides?: Partial<Track>) => Track;
  _pickMirrorSearchQuery: (track: Partial<Track> | null | undefined) => string;
  _searchDeezerTracks: (query: string, limit: number, requestedBy: string | null) => Promise<Track[]>;
  _pickBestSpotifyMirror: (metadataTrack: Partial<Track> | null | undefined, candidates: unknown) => Track | null;
  _resolveCrossSourceToYouTube: (
    sourceTracks: Array<{ title?: string; artist?: string | null; durationInSec?: number | null; isrc?: string | null }>,
    requestedBy: string | null,
    source: string,
  ) => Promise<Track[]>;
  _parseDurationSeconds?: (value: unknown) => number | null;
  _resolveFromUrlFallbackSearch: (url: string, requestedBy: string | null, source: string) => Promise<Track[]>;
  deezerArl?: string | null;
  enableDeezerImport?: boolean;
  maxPlaylistTracks: number;
  logger?: { warn?: (message: string, payload?: Record<string, unknown>) => void };
};

function decodeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function normalizeLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = [];
  let cursor = 0;
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, concurrency));
  await Promise.all(Array.from({ length: safeConcurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!response?.ok) {
    throw new Error(`Request failed (${response?.status ?? 'network'})`);
  }
  return response.text().catch(() => '');
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!response?.ok) {
    throw new Error(`Request failed (${response?.status ?? 'network'})`);
  }
  return response.json().catch(() => null) as Promise<Record<string, any> | null>;
}

function parseDurationSeconds(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIsrc(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length === 12 ? normalized : null;
}

async function resolveMirror(
  runtime: MirrorRuntime,
  metadataTrack: Track,
  requestedBy: string | null,
  source: string
) {
  const query = runtime._pickMirrorSearchQuery(metadataTrack);
  if (!query) {
    throw new ValidationError(`Could not build ${source} mirror search query.`);
  }

  const durationInSec = runtime._parseDurationSeconds?.(metadataTrack.duration) ?? null;
  if (runtime.deezerArl && runtime.enableDeezerImport) {
    const deezerMatches = await runtime._searchDeezerTracks(query, 3, requestedBy).catch(() => []);
    const deezerBest = runtime._pickBestSpotifyMirror(metadataTrack, deezerMatches);
    if (deezerBest) {
      return [runtime._cloneTrack(deezerBest, {
        source: `${source}-${deezerBest.source ?? 'deezer-search'}`,
        requestedBy,
      })];
    }
  }

  return runtime._resolveCrossSourceToYouTube([{
    ...(metadataTrack.title ? { title: metadataTrack.title } : {}),
    ...(metadataTrack.artist ? { artist: metadataTrack.artist } : {}),
    ...(durationInSec != null ? { durationInSec } : {}),
    ...(metadataTrack.isrc ? { isrc: metadataTrack.isrc } : {}),
  }], requestedBy, source);
}

async function resolveCollection(
  runtime: MirrorRuntime,
  items: Track[],
  requestedBy: string | null,
  source: string,
  limit: number
) {
  const mirrored = await mapWithConcurrency(items.slice(0, limit), MIRROR_COLLECTION_CONCURRENCY, async (item) => {
    try {
      const resolved = await resolveMirror(runtime, item, requestedBy, source);
      return resolved[0] ?? null;
    } catch (err) {
      runtime.logger?.warn?.(`Failed to mirror ${source} track`, {
        title: item.title ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });
  return mirrored.filter(Boolean) as Track[];
}

function buildAudiomackSignature(method: string, url: string, params: Record<string, string>) {
  const strictEncode = (str: string) => encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${strictEncode(key)}=${strictEncode(params[key]!)}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    strictEncode(url),
    strictEncode(paramString),
  ].join('&');
  return crypto.createHmac('sha1', `${AUDIOMACK_CONSUMER_SECRET}&`).update(baseString).digest('base64');
}

async function audiomackRequest(endpoint: string, extraParams: Record<string, string> = {}) {
  const params = {
    ...extraParams,
    oauth_consumer_key: AUDIOMACK_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  const signature = buildAudiomackSignature('GET', endpoint, params);
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('oauth_signature', signature);
  return fetchJson(url.toString());
}

async function jiosaavnRequest(params: Record<string, string>) {
  const url = new URL(JIOSAAVN_API_BASE);
  url.search = new URLSearchParams({
    _format: 'json',
    _marker: '0',
    cc: 'in',
    ctx: 'web6dot0',
    ...params,
  }).toString();
  return fetchJson(url.toString(), {
    method: 'GET',
    headers: JIOSAAVN_HEADERS,
  });
}

function parseBandcampTralbum(html: string) {
  const match = html.match(/data-tralbum=(["'])(.+?)\1/);
  const raw = match?.[2] ?? null;
  if (!raw) return null;
  try {
    return JSON.parse(decodeHtml(raw));
  } catch {
    return null;
  }
}

function parseAudiomackSong(json: unknown) {
  const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const result = record?.results ?? record?.result ?? record;
  if (Array.isArray(result)) return result[0] ?? null;
  return result ?? null;
}

function parseMixcloudTrack(data: Record<string, unknown> | null | undefined, source: string) {
  if (!data?.url || !data?.name) return null;
  return {
    title: String(data.name).trim(),
    url: String(data.url).trim(),
    duration: parseDurationSeconds(data.audioLength) ?? 'Unknown',
    thumbnailUrl: normalizeThumbnailUrl((data.picture as { url?: unknown } | null | undefined)?.url ?? null),
    artist: String((data.owner as { displayName?: unknown } | null | undefined)?.displayName ?? '').trim() || null,
    source,
  };
}

function parseJioSaavnTrack(item: Record<string, unknown> | null | undefined) {
  if (!item) return null;
  const moreInfo = item.more_info as Record<string, unknown> | null | undefined;
  const artistMap = moreInfo?.artistMap as Record<string, unknown> | null | undefined;
  const primaryArtists = Array.isArray(artistMap?.primary_artists)
    ? artistMap?.primary_artists as Array<{ name?: unknown }>
    : [];
  const artist = primaryArtists.length
    ? primaryArtists.map((entry) => String(entry?.name ?? '').trim()).filter(Boolean).join(', ')
    : String(moreInfo?.music ?? item.primary_artists ?? item.singers ?? '').trim() || null;
  const image = String(item.image ?? '').replace('150x150', '500x500');

  return {
    title: decodeHtml(item.title ?? item.song ?? 'JioSaavn track'),
    url: String(item.perma_url ?? '').trim() || 'https://www.jiosaavn.com',
    duration: parseDurationSeconds(moreInfo?.duration ?? item.duration) ?? 'Unknown',
    thumbnailUrl: normalizeThumbnailUrl(image),
    artist,
    isrc: null,
  };
}

export const mirrorImportMethods: LooseMethodMap = {
  async _resolveBandcampByGuess(url: string, requestedBy: string | null, limit?: number | null) {
    const entity = extractBandcampEntity(url);
    if (!entity) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'bandcamp-fallback');
    }

    const html = await fetchText(url);
    const tralbum = parseBandcampTralbum(html);
    if (!tralbum?.trackinfo?.length) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'bandcamp-fallback');
    }

    const artist = String(tralbum.artist ?? '').trim() || entity.subdomain;
    const thumbnailUrl = tralbum.art_id
      ? `https://f4.bcbits.com/img/a${encodeURIComponent(String(tralbum.art_id))}_10.jpg`
      : null;

    const items = tralbum.trackinfo
      .map((entry: Record<string, unknown>) => {
        const title = String(entry.title ?? '').trim();
        if (!title) return null;
        const itemUrl = isHttpUrl(entry.title_link)
          ? String(entry.title_link).trim()
          : new URL(String(entry.title_link ?? url), url).toString();
        return this._buildTrack({
          title,
          url: itemUrl,
          duration: parseDurationSeconds(entry.duration) ?? 'Unknown',
          thumbnailUrl,
          requestedBy,
          source: entity.type === 'album' ? 'bandcamp-album' : 'bandcamp',
          artist,
        });
      })
      .filter(Boolean) as Track[];

    if (entity.type === 'track' || items.length === 1) {
      return resolveMirror(this, items[0]!, requestedBy, 'bandcamp');
    }

    const safeLimit = normalizeLimit(limit, this.maxPlaylistTracks);
    return resolveCollection(this, items, requestedBy, 'bandcamp', safeLimit);
  },

  async _resolveAudiomackByGuess(url: string, requestedBy: string | null) {
    const entity = extractAudiomackEntity(url);
    if (!entity || entity.type !== 'song' || !entity.slug) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audiomack-fallback');
    }

    const payload = await audiomackRequest(
      `${AUDIOMACK_API_BASE}/music/song/${encodeURIComponent(entity.user)}/${entity.slug}`,
      { section: new URL(url).pathname }
    ).catch(() => null);
    const song = parseAudiomackSong(payload) as Record<string, unknown> | null;
    if (!song?.id) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audiomack-fallback');
    }

    const metadataTrack = this._buildTrack({
      title: String(song.title ?? song.name ?? 'Audiomack track').trim() || 'Audiomack track',
      url: String(song.url ?? url).trim() || url,
      duration: parseDurationSeconds(song.duration ?? song.duration_sec) ?? 'Unknown',
      thumbnailUrl: normalizeThumbnailUrl(song.image_base ?? song.image ?? song.cover ?? null) ?? pickThumbnailUrlFromItem(song),
      requestedBy,
      source: 'audiomack',
      artist: String(
        song.artist
        ?? (song.uploader && typeof song.uploader === 'object' ? (song.uploader as Record<string, unknown>).name : null)
        ?? (song.user && typeof song.user === 'object' ? (song.user as Record<string, unknown>).name : null)
        ?? ''
      ).trim() || null,
      isrc: normalizeIsrc(song.isrc),
    });

    return resolveMirror(this, metadataTrack, requestedBy, 'audiomack');
  },

  async _resolveMixcloudByGuess(url: string, requestedBy: string | null, limit?: number | null) {
    const entity = extractMixcloudEntity(url);
    if (!entity) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'mixcloud-fallback');
    }

    const request = async (query: string) => {
      const endpoint = `https://app.mixcloud.com/graphql?query=${encodeURIComponent(query)}`;
      return fetchJson(endpoint, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });
    };

    if (entity.type === 'track' && entity.slug) {
      const payload = await request(`{
        cloudcastLookup(lookup: {username: "${entity.user}", slug: "${entity.slug}"}) {
          audioLength
          name
          url
          owner { displayName username }
          picture(width: 1024, height: 1024) { url }
        }
      }`).catch(() => null);
      const seed = parseMixcloudTrack((payload as Record<string, any> | null | undefined)?.data?.cloudcastLookup ?? null, 'mixcloud');
      if (!seed) {
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'mixcloud-fallback');
      }
      const metadataTrack = this._buildTrack({ ...seed, requestedBy });
      return resolveMirror(this, metadataTrack, requestedBy, 'mixcloud');
    }

    if (entity.type === 'playlist' && entity.slug) {
      const payload = await request(`{
        playlistLookup(lookup: {username: "${entity.user}", slug: "${entity.slug}"}) {
          items(first: ${normalizeLimit(limit, this.maxPlaylistTracks)}) {
            edges {
              node {
                cloudcast {
                  audioLength
                  name
                  url
                  owner { displayName username }
                  picture(width: 1024, height: 1024) { url }
                }
              }
            }
          }
        }
      }`).catch(() => null);

      const items = Array.isArray((payload as Record<string, any> | null | undefined)?.data?.playlistLookup?.items?.edges)
        ? (payload as Record<string, any>).data.playlistLookup.items.edges
            .map((edge: Record<string, unknown>) => parseMixcloudTrack(
              (edge.node as Record<string, unknown> | null | undefined)?.cloudcast as Record<string, unknown> | null | undefined,
              'mixcloud-playlist'
            ))
            .filter(Boolean)
            .map((seed: any) => this._buildTrack({ ...seed, requestedBy })) as Track[]
        : [];

      if (!items.length) {
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'mixcloud-fallback');
      }
      return resolveCollection(this, items, requestedBy, 'mixcloud', normalizeLimit(limit, this.maxPlaylistTracks));
    }

    return this._resolveFromUrlFallbackSearch(url, requestedBy, 'mixcloud-fallback');
  },

  async _resolveJioSaavnByGuess(url: string, requestedBy: string | null, limit?: number | null) {
    const entity = extractJioSaavnEntity(url);
    if (!entity) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'jiosaavn-fallback');
    }

    if (entity.type === 'song') {
      let payload = await jiosaavnRequest({ __call: 'song.getDetails', pids: entity.id }).catch(() => null) as Record<string, any> | null;
      let song = payload?.[entity.id] ?? payload?.songs?.[0] ?? null;
      if (!song) {
        payload = await jiosaavnRequest({
          __call: 'webapi.get',
          api_version: '4',
          token: entity.id,
          type: 'song',
        }).catch(() => null) as Record<string, any> | null;
        song = payload?.songs?.[0] ?? null;
      }

      const parsed = parseJioSaavnTrack(song as Record<string, unknown> | null);
      if (!parsed) {
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'jiosaavn-fallback');
      }
      const metadataTrack = this._buildTrack({
        ...parsed,
        requestedBy,
        source: 'jiosaavn',
      });
      return resolveMirror(this, metadataTrack, requestedBy, 'jiosaavn');
    }

    const payload = await jiosaavnRequest({
      __call: 'webapi.get',
      api_version: '4',
      token: entity.id,
      type: entity.type === 'featured' || entity.type === 'playlist' ? 'playlist' : entity.type,
      [entity.type === 'artist' ? 'n_song' : 'n']: String(normalizeLimit(limit, this.maxPlaylistTracks)),
    }).catch(() => null) as Record<string, any> | null;

    const list = Array.isArray(payload?.list)
      ? payload.list
      : (Array.isArray(payload?.topSongs) ? payload.topSongs : []);
    const items = list
      .map((entry: Record<string, unknown>) => parseJioSaavnTrack(entry))
      .filter(Boolean)
      .map((seed: any) => this._buildTrack({
        ...seed,
        requestedBy,
        source: `jiosaavn-${entity.type}`,
      })) as Track[];

    if (!items.length) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'jiosaavn-fallback');
    }

    return resolveCollection(this, items, requestedBy, 'jiosaavn', normalizeLimit(limit, this.maxPlaylistTracks));
  },
};
