import { PassThrough } from 'node:stream';
import type { ReadableStreamReadResult } from 'node:stream/web';
import playdl from 'play-dl';
import type { Deezer, DeezerAlbum, DeezerPlaylist } from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import type { Track } from '../../types/domain.ts';
import {
  buildDeezerLegacyDownloadUrl,
  DeezerBfStripeDecryptTransform,
  DEEZER_MEDIA_QUALITY_MAP,
  DEEZER_SESSION_TOKEN_TTL_MS,
  DEEZER_STREAM_BASE_BACKOFF_MS,
  DEEZER_STREAM_CONNECT_TIMEOUT_MS,
  DEEZER_STREAM_HIGH_WATER_MARK,
  DEEZER_STREAM_MAX_BACKOFF_MS,
  DEEZER_STREAM_READ_TIMEOUT_MS,
  DEEZER_STREAM_RETRY_LIMIT,
  isRetryableDeezerStreamError,
  parseContentRangeStart,
} from './deezer.ts';
import { extractDeezerTrackId, isHttpUrl, pickThumbnailUrlFromItem, toDeezerDurationLabel } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import { asRecord, readNested } from '../../utils/unknownData.ts';

type DeezerResponseLike = {
  headers?: {
    getSetCookie?: () => string[];
    get?: (name: string) => string | null;
  } | null;
};

export type DeezerSessionTokens = {
  apiToken: string;
  licenseToken: string;
  sessionId: string | null;
  dzrUniqId: string | null;
  expiresAtMs: number;
};

export type DeezerStreamMeta = {
  url: string;
  cipherType: string;
  format: string | null;
};

type DeezerResolvedStream = DeezerStreamMeta & {
  trackId: string;
};

type DeezerSongData = {
  MD5_ORIGIN: string;
  SNG_ID: string;
  MEDIA_VERSION: string;
};

type DeezerStreamConnection = {
  response: Response;
  controller: AbortController;
};

export interface DeezerMethodMembers {
  _resolveDeezerTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveDeezerCollection(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _deezerApiRequest(pathname: string, timeoutMs?: number): Promise<unknown>;
  _buildDeezerTrackFromMetadata(meta: unknown, requestedBy: string | null, source?: string): Track | null;
  _resolveDeezerTrackDirect(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveDeezerCollectionDirect(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _deezerGatewayCall(method: string, apiToken?: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  _getDeezerCookieHeader(): string;
  _updateDeezerCookieHeader(response: DeezerResponseLike | null | undefined): void;
  _readDeezerCookieValue(name: unknown): string | null;
  _getDeezerSessionTokens(forceRefresh?: boolean): Promise<DeezerSessionTokens>;
  _extractDeezerError(errorValue: unknown): string | null;
  _extractFirstHttpUrl(value: unknown): string | null;
  _pickDeezerPreferredFormat(candidate: unknown): string;
  _resolveDeezerMediaVariantFromResponse(body: unknown): DeezerStreamMeta | null;
  _extractFirstStringByKey(value: unknown, targetKey: unknown): string | null;
  _resolveDeezerSongData(apiToken: string, trackId: unknown): Promise<DeezerSongData | null>;
  _resolveDeezerLegacyEncryptedStreamUrl(apiToken: string, trackId: unknown, preferredFormat?: unknown): Promise<DeezerStreamMeta | null>;
  _resolveDeezerFullStreamUrlWithArl(trackId: unknown): Promise<string>;
  _resolveDeezerTrackToken(apiToken: string, trackId: unknown): Promise<string | null>;
  _resolveDeezerStreamUrl(track: Partial<Track> | null | undefined): Promise<DeezerResolvedStream>;
  _sleep(ms: unknown): Promise<void>;
  _openDeezerStreamConnection(streamUrl: string, offset?: number): Promise<DeezerStreamConnection>;
  _readDeezerStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: AbortController | null
  ): Promise<ReadableStreamReadResult<Uint8Array>>;
  _createDeezerResilientReadable(streamUrl: string): PassThrough;
  _startDeezerEncryptedPipeline(streamUrl: string, trackId: unknown, seekSec?: number): Promise<void>;
  _startDeezerPipeline(track: Partial<Track> | null | undefined, seekSec?: number): Promise<void>;
}

function isDeezerCollection(data: Deezer): data is DeezerPlaylist | DeezerAlbum {
  return data.type === 'playlist' || data.type === 'album';
}

export const deezerMethods: DeezerMethodMembers & ThisType<MusicPlayer> = {
  async _resolveDeezerTrack(url: string, requestedBy: string | null) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    if (this.deezerArl) {
      try {
        const direct = await this._resolveDeezerTrackDirect(url, requestedBy);
        if (direct.length) return direct;
      } catch (err) {
        this.logger?.warn?.('Direct Deezer track resolve failed, falling back to mapped source', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const data = await playdl.deezer(url);
    if (!data || data.type !== 'track') return [];
    return this._resolveCrossSourceToYouTube([data], requestedBy, 'deezer');
  },

  async _resolveDeezerCollection(url: string, requestedBy: string | null, limit?: number | null) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    if (this.deezerArl) {
      try {
        const direct = await this._resolveDeezerCollectionDirect(url, requestedBy, limit);
        if (direct.length) return direct;
      } catch (err) {
        this.logger?.warn?.('Direct Deezer collection resolve failed, falling back to mapped source', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const data = await playdl.deezer(url);
    if (!data || !isDeezerCollection(data)) return [];

    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));
    const tracks = await data.all_tracks();
    return this._resolveCrossSourceToYouTube(tracks.slice(0, safeLimit), requestedBy, `deezer-${data.type}`);
  },

  async _deezerApiRequest(pathname: string, timeoutMs = 10_000) {
    const endpoint = new URL(pathname, 'https://api.deezer.com');
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Deezer API request failed (${response?.status ?? 'network'}): ${endpoint.pathname}`);
    }

    return response.json();
  },

  _buildDeezerTrackFromMetadata(meta: unknown, requestedBy: string | null, source = 'deezer-direct') {
    const record = asRecord(meta);
    const trackId = String(record?.id ?? '').trim();
    if (!trackId) return null;

    const title = String(record?.title ?? 'Deezer track').trim() || 'Deezer track';
    const artist = String(readNested(record, ['artist', 'name']) ?? '').trim() || null;
    const duration = toDeezerDurationLabel(record?.duration ?? null);
    const deezerUrl = String(record?.link ?? '').trim() || `https://www.deezer.com/track/${encodeURIComponent(trackId)}`;
    const previewUrl = String(record?.preview ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta);

    return this._buildTrack({
      title,
      url: deezerUrl,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      deezerTrackId: trackId,
      deezerPreviewUrl: previewUrl,
    });
  },

  async _resolveDeezerTrackDirect(url: string, requestedBy: string | null) {
    const trackId = extractDeezerTrackId(url);
    if (!trackId) {
      throw new Error('Could not extract Deezer track id from URL.');
    }

    const payload = await this._deezerApiRequest(`/track/${encodeURIComponent(trackId)}`);
    const track = this._buildDeezerTrackFromMetadata(payload, requestedBy, 'deezer-direct');
    if (track?.deezerTrackId) {
      const fullUrl = await this._resolveDeezerFullStreamUrlWithArl(track.deezerTrackId);
      track.deezerFullStreamUrl = fullUrl;
      track.deezerPreviewUrl = null;
    }
    return track ? [track] : [];
  },

  async _resolveDeezerCollectionDirect(url: string, requestedBy: string | null, limit?: number | null) {
    let payload: unknown = null;
    let isPlaylist = false;
    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));

    const parsed = new URL(url);
    const parts = String(parsed.pathname ?? '').split('/').map((segment) => segment.trim()).filter(Boolean);
    const playlistIdx = parts.findIndex((segment) => segment.toLowerCase() === 'playlist');
    const albumIdx = parts.findIndex((segment) => segment.toLowerCase() === 'album');

    const playlistId = parts[playlistIdx + 1] ?? null;
    const albumId = parts[albumIdx + 1] ?? null;

    if (playlistIdx >= 0 && playlistId && /^\d+$/.test(playlistId)) {
      isPlaylist = true;
      payload = await this._deezerApiRequest(`/playlist/${encodeURIComponent(playlistId)}`);
    } else if (albumIdx >= 0 && albumId && /^\d+$/.test(albumId)) {
      payload = await this._deezerApiRequest(`/album/${encodeURIComponent(albumId)}`);
    } else {
      throw new Error('Could not extract Deezer playlist/album id from URL.');
    }

    const rawData = readNested(payload, ['tracks', 'data']);
    const rawTracks: unknown[] = Array.isArray(rawData) ? rawData : [];
    const tracks: Track[] = [];
    for (const entry of rawTracks) {
      if (tracks.length >= safeLimit) break;
      const track = this._buildDeezerTrackFromMetadata(
        entry,
        requestedBy,
        isPlaylist ? 'deezer-direct-playlist' : 'deezer-direct-album'
      );
      if (!track) continue;

      try {
        const fullUrl = await this._resolveDeezerFullStreamUrlWithArl(track.deezerTrackId);
        track.deezerFullStreamUrl = fullUrl;
        track.deezerPreviewUrl = null;
        tracks.push(track);
      } catch (err) {
        this.logger?.warn?.('Skipping Deezer direct track without full stream token', {
          trackId: track.deezerTrackId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return tracks;
  },

  async _deezerGatewayCall(method: string, apiToken = 'null', args: Record<string, unknown> = {}, timeoutMs = 10_000) {
    if (!this.deezerArl) {
      throw new Error('DEEZER_ARL is not configured.');
    }

    const endpoint = new URL('https://www.deezer.com/ajax/gw-light.php');
    endpoint.searchParams.set('method', method);
    endpoint.searchParams.set('input', '3');
    endpoint.searchParams.set('api_version', '1.0');
    endpoint.searchParams.set('api_token', apiToken);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: this._getDeezerCookieHeader(),
        referer: 'https://www.deezer.com/',
        origin: 'https://www.deezer.com',
        'user-agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Deezer gateway call failed (${response?.status ?? 'network'}): ${method}`);
    }
    this._updateDeezerCookieHeader(response);

    const body: unknown = await response.json();
    const deezerError = this._extractDeezerError(readNested(body, ['error']));
    if (deezerError) {
      throw new Error(`Deezer gateway ${method} returned error: ${deezerError}`);
    }
    return body;
  },

  _getDeezerCookieHeader(): string {
    return this._deezerCookieHeader || `arl=${this.deezerArl}`;
  },

  _updateDeezerCookieHeader(response: DeezerResponseLike | null | undefined) {
    const arl = this.deezerArl;
    if (!response?.headers || !arl) return;

    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (() => {
          const single = response.headers.get?.('set-cookie') ?? null;
          return single ? [single] : [];
        })();

    const cookieMap = new Map<string, string>();
    for (const pair of String(this._deezerCookieHeader || `arl=${arl}`).split(';')) {
      const segment = pair.trim();
      if (!segment) continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (key && value) cookieMap.set(key, value);
    }
    if (!cookieMap.has('arl')) {
      cookieMap.set('arl', arl);
    }

    for (const raw of setCookies) {
      const first = String(raw ?? '').split(';')[0]?.trim() || '';
      if (!first) continue;
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const key = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (key && value) cookieMap.set(key, value);
    }

    this._deezerCookieHeader = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  },

  _readDeezerCookieValue(name: unknown) {
    const target = String(name ?? '').trim();
    if (!target) return null;

    const header = String(this._deezerCookieHeader || `arl=${this.deezerArl ?? ''}`);
    for (const pair of header.split(';')) {
      const segment = pair.trim();
      if (!segment) continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      if (key !== target) continue;
      const value = segment.slice(eq + 1).trim();
      if (value) return value;
    }
    return null;
  },

  async _getDeezerSessionTokens(forceRefresh = false) {
    if (!this.deezerArl) {
      throw new Error('DEEZER_ARL is not configured.');
    }

    const now = Date.now();
    if (!forceRefresh && this._deezerSessionTokens && this._deezerSessionTokens.expiresAtMs > now) {
      return this._deezerSessionTokens;
    }

    const userData = await this._deezerGatewayCall('deezer.getUserData', 'null', {});
    const results = readNested(userData, ['results']);
    const apiToken = String(readNested(results, ['checkForm']) ?? '').trim();
    const licenseToken = String(
      readNested(results, ['USER', 'OPTIONS', 'license_token']) ?? readNested(results, ['OPTIONS', 'license_token']) ?? ''
    ).trim();
    if (!apiToken || !licenseToken) {
      throw new Error('Deezer ARL session did not provide API/license tokens.');
    }

    const tokens: DeezerSessionTokens = {
      apiToken,
      licenseToken,
      sessionId: this._readDeezerCookieValue('sid'),
      dzrUniqId: this._readDeezerCookieValue('dzr_uniq_id'),
      expiresAtMs: now + DEEZER_SESSION_TOKEN_TTL_MS,
    };
    this._deezerSessionTokens = tokens;
    return tokens;
  },

  _extractDeezerError(errorValue: unknown) {
    if (!errorValue) return null;
    if (Array.isArray(errorValue)) {
      if (!errorValue.length) return null;
      const first = errorValue[0];
      return typeof first === 'string' ? first : JSON.stringify(first);
    }
    if (typeof errorValue === 'string') {
      return errorValue.trim() || null;
    }
    if (typeof errorValue === 'object') {
      const firstEntry = Object.entries(errorValue)[0];
      if (!firstEntry) return null;
      const [key, val] = firstEntry;
      if (typeof val === 'string' && val.trim()) {
        return `${key}: ${val.trim()}`;
      }
      return key;
    }
    return String(errorValue);
  },

  _extractFirstHttpUrl(value: unknown) {
    if (!value) return null;
    if (typeof value === 'string') {
      return isHttpUrl(value) ? value : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = this._extractFirstHttpUrl(entry);
        if (candidate) return candidate;
      }
      return null;
    }
    if (typeof value === 'object') {
      for (const entry of Object.values(value)) {
        const candidate = this._extractFirstHttpUrl(entry);
        if (candidate) return candidate;
      }
    }
    return null;
  },

  _pickDeezerPreferredFormat(candidate: unknown) {
    const upper = String(candidate ?? '').trim().toUpperCase();
    if (DEEZER_MEDIA_QUALITY_MAP.has(upper)) return upper;
    return 'MP3_128';
  },

  _resolveDeezerMediaVariantFromResponse(body: unknown) {
    const data = readNested(body, ['data']);
    const firstItem: unknown = Array.isArray(data) ? data[0] : null;
    const media = readNested(firstItem, ['media']);
    const firstMedia = asRecord(Array.isArray(media) ? media[0] : null);
    if (!firstMedia) return null;

    const sources: unknown[] | null = Array.isArray(firstMedia.sources) ? firstMedia.sources : null;
    let selectedSource: unknown = sources ? sources[0] ?? null : null;
    let url = String(readNested(selectedSource, ['url']) ?? '').trim();
    if (!isHttpUrl(url) && sources) {
      selectedSource = sources.find((entry) => {
        const entryRecord = asRecord(entry);
        if (!entryRecord) return false;
        const url = String(entryRecord.url ?? '').trim();
        return isHttpUrl(url);
      }) ?? null;
      url = String(readNested(selectedSource, ['url']) ?? '').trim();
    }
    if (!isHttpUrl(url)) return null;

    return {
      url,
      cipherType: String(readNested(firstMedia, ['cipher', 'type']) ?? firstMedia.cipher ?? 'BF_CBC_STRIPE').trim().toUpperCase() || 'BF_CBC_STRIPE',
      format: String(firstMedia.format ?? readNested(selectedSource, ['format']) ?? '').trim().toUpperCase() || null,
    };
  },

  _extractFirstStringByKey(value: unknown, targetKey: unknown) {
    if (!value || !targetKey) return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this._extractFirstStringByKey(entry, targetKey);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;

    for (const [key, entry] of Object.entries(value)) {
      if (key === targetKey && typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) return trimmed;
      }
    }
    for (const entry of Object.values(value)) {
      const found = this._extractFirstStringByKey(entry, targetKey);
      if (found) return found;
    }
    return null;
  },

  async _resolveDeezerSongData(apiToken: string, trackId: unknown) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) return null;

    const requests = [
      this._deezerGatewayCall('song.getData', apiToken, { sng_id: safeTrackId }).catch(() => null),
      this._deezerGatewayCall('deezer.pageTrack', apiToken, { sng_id: safeTrackId }).catch(() => null),
      this._deezerGatewayCall('song.getListData', apiToken, { sng_ids: [safeTrackId] }).catch(() => null),
    ];

    for (const request of requests) {
      const payload = await request;
      if (!payload) continue;
      const results = readNested(payload, ['results']) ?? {};
      const dataCandidate = readNested(results, ['DATA']) ?? readNested(results, ['data', '0']) ?? results;
      const md5Origin = String(readNested(dataCandidate, ['MD5_ORIGIN']) ?? '').trim();
      const songId = String(readNested(dataCandidate, ['SNG_ID']) ?? safeTrackId).trim();
      const mediaVersion = String(readNested(dataCandidate, ['MEDIA_VERSION']) ?? '').trim();

      if (md5Origin && songId && mediaVersion) {
        return { MD5_ORIGIN: md5Origin, SNG_ID: songId, MEDIA_VERSION: mediaVersion };
      }
    }

    return null;
  },

  async _resolveDeezerLegacyEncryptedStreamUrl(apiToken: string, trackId: unknown, preferredFormat: unknown = null) {
    const track = await this._resolveDeezerSongData(apiToken, trackId);
    if (!track) return null;

    const preferred = this._pickDeezerPreferredFormat(preferredFormat);
    const qualityOrder = [preferred, 'MP3_320', 'MP3_128', 'FLAC'];
    const seen = new Set<string>();

    for (const format of qualityOrder) {
      if (seen.has(format)) continue;
      seen.add(format);
      const quality = DEEZER_MEDIA_QUALITY_MAP.get(format);
      if (!quality) continue;
      const url = buildDeezerLegacyDownloadUrl(track, quality);
      if (url && isHttpUrl(url)) {
        return { url, cipherType: 'BF_CBC_STRIPE', format };
      }
    }

    return null;
  },

  async _resolveDeezerFullStreamUrlWithArl(trackId: unknown) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) {
      throw new Error('Missing Deezer track id.');
    }

    const formats = this.deezerTrackFormats.map((format) => ({ cipher: 'BF_CBC_STRIPE', format }));
    let lastMediaError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tokens = await this._getDeezerSessionTokens(attempt > 0);
      const trackToken = await this._resolveDeezerTrackToken(tokens.apiToken, safeTrackId);
      if (!trackToken) {
        if (attempt === 0) {
          this._deezerSessionTokens = null;
          continue;
        }
        throw new Error('Missing Deezer track token (likely unavailable for this account/region).');
      }

      const payload = {
        license_token: tokens.licenseToken,
        media: [{ type: 'FULL', formats }],
        track_tokens: [trackToken],
      };

      const response = await fetch('https://media.deezer.com/v1/get_url', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: this._getDeezerCookieHeader(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);

      if (!response?.ok) {
        lastMediaError = new Error(`Deezer media URL call failed (${response?.status ?? 'network'})`);
        if (attempt === 0) {
          this._deezerSessionTokens = null;
          continue;
        }
        break;
      }
      this._updateDeezerCookieHeader(response);

      const body: unknown = await response.json().catch(() => null);
      const variant = this._resolveDeezerMediaVariantFromResponse(body);
      if (variant?.url) {
        this._setDeezerStreamMeta(safeTrackId, {
          url: variant.url,
          cipherType: variant.cipherType || 'BF_CBC_STRIPE',
          format: variant.format || null,
        });
        return variant.url;
      }

      lastMediaError = new Error('Deezer media URL response did not contain a playable source.');
      if (attempt === 0) {
        this._deezerSessionTokens = null;
        continue;
      }
      break;
    }

    const apiToken = this._deezerSessionTokens?.apiToken ?? null;
    const legacy = apiToken
      ? await this._resolveDeezerLegacyEncryptedStreamUrl(apiToken, safeTrackId, this.deezerTrackFormats[0]).catch(() => null)
      : null;
    if (legacy?.url) {
      this._setDeezerStreamMeta(safeTrackId, {
        url: legacy.url,
        cipherType: legacy.cipherType || 'BF_CBC_STRIPE',
        format: legacy.format || null,
      });
      return legacy.url;
    }

    throw lastMediaError ?? new Error('No Deezer stream URL available from media API or legacy fallback.');
  },

  async _resolveDeezerTrackToken(apiToken: string, trackId: unknown) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) return null;

    const payload = await this._deezerGatewayCall('song.getData', apiToken, { sng_id: safeTrackId }).catch(() => null);
    if (!payload) return null;

    const direct = String(readNested(payload, ['results', 'TRACK_TOKEN']) ?? '').trim();
    if (direct) return direct;

    const recursive = this._extractFirstStringByKey(readNested(payload, ['results']) ?? payload, 'TRACK_TOKEN');
    return recursive || null;
  },

  async _resolveDeezerStreamUrl(track: Partial<Track> | null | undefined) {
    const trackId = String(track?.deezerTrackId ?? '').trim() || String(extractDeezerTrackId(track?.url) ?? '').trim();
    const pinned = String(track?.deezerFullStreamUrl ?? '').trim();
    const cachedMeta = trackId ? this._deezerStreamMetaByTrackId.get(trackId) : null;

    if (pinned && isHttpUrl(pinned)) {
      if (cachedMeta && cachedMeta.url === pinned) {
        return { url: pinned, cipherType: cachedMeta.cipherType || 'NONE', format: cachedMeta.format || null, trackId };
      }
      return { url: pinned, cipherType: 'NONE', format: null, trackId };
    }

    if (this.deezerArl && trackId) {
      const url = await this._resolveDeezerFullStreamUrlWithArl(trackId);
      const meta = this._deezerStreamMetaByTrackId.get(trackId);
      return { url, cipherType: meta?.cipherType || 'NONE', format: meta?.format || null, trackId };
    }

    throw new Error('No playable Deezer full stream URL available.');
  },

  async _sleep(ms: unknown) {
    const waitMs = Math.max(0, Number.parseInt(String(ms), 10) || 0);
    if (waitMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  },

  async _openDeezerStreamConnection(streamUrl: string, offset = 0) {
    const headers: Record<string, string> = { accept: '*/*' };
    if (this.deezerArl) {
      headers.cookie = this._getDeezerCookieHeader();
    }

    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
    if (safeOffset > 0) {
      headers.range = `bytes=${safeOffset}-`;
    }

    const controller = new AbortController();
    const connectTimeout = setTimeout(() => {
      controller.abort(new Error('Deezer stream connection timed out.'));
    }, DEEZER_STREAM_CONNECT_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(streamUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimeout);
    }

    if (!response?.ok || !response.body) {
      throw new Error(`Failed to fetch encrypted Deezer stream (${response?.status ?? 'network'})`);
    }
    this._updateDeezerCookieHeader(response);

    if (safeOffset > 0) {
      if (response.status !== 206) {
        throw new Error(`Deezer stream did not honor range resume (status ${response.status}).`);
      }

      const rangeStart = parseContentRangeStart(response.headers.get('content-range'));
      if (rangeStart == null || rangeStart !== safeOffset) {
        throw new Error(`Deezer stream resumed at unexpected offset (${rangeStart ?? 'unknown'} != ${safeOffset}).`);
      }
    }

    return { response, controller };
  },

  async _readDeezerStreamChunkWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController | null) {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller?.abort?.(new Error('Deezer stream body read timed out.'));
            const timeoutError = Object.assign(new Error('Deezer stream body read timed out.'), { code: 'ETIMEDOUT' });
            reject(timeoutError);
          }, DEEZER_STREAM_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  },

  _createDeezerResilientReadable(streamUrl: string) {
    const out = new PassThrough({ highWaterMark: DEEZER_STREAM_HIGH_WATER_MARK });
    let offset = 0;
    let attempts = 0;
    let closed = false;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let activeResponseController: AbortController | null = null;

    const onClose = () => {
      closed = true;
      activeResponseController?.abort?.();
      activeResponseController = null;
      const reader = activeReader;
      activeReader = null;
      if (!reader?.cancel) return;
      void Promise.resolve(reader.cancel()).catch(() => null);
    };
    out.once('close', onClose);
    out.once('error', onClose);

    const run = async () => {
      while (!closed) {
        let connection;
        try {
          connection = await this._openDeezerStreamConnection(streamUrl, offset);
        } catch (err) {
          if (!isRetryableDeezerStreamError(err) || attempts >= DEEZER_STREAM_RETRY_LIMIT) {
            out.destroy(err instanceof Error ? err : new Error(String(err)));
            return;
          }

          const backoffMs = Math.min(DEEZER_STREAM_MAX_BACKOFF_MS, DEEZER_STREAM_BASE_BACKOFF_MS * (2 ** attempts));
          attempts += 1;
          await this._sleep(backoffMs);
          continue;
        }

        attempts = 0;
        activeResponseController = connection.controller;
        const response = connection.response;
        activeReader = response.body?.getReader?.() ?? null;
        if (!activeReader) {
          out.destroy(new Error('Encrypted Deezer response body is not readable.'));
          return;
        }

        try {
          while (!closed) {
            const { done, value } = await this._readDeezerStreamChunkWithTimeout(activeReader, activeResponseController);
            if (done) {
              out.end();
              return;
            }

            if (!value || value.length === 0) continue;
            offset += value.length;
            if (!out.write(Buffer.from(value))) {
              await new Promise((resolve) => out.once('drain', resolve));
            }
          }
        } catch (err) {
          if (closed) return;
          if (!isRetryableDeezerStreamError(err) || attempts >= DEEZER_STREAM_RETRY_LIMIT) {
            out.destroy(err instanceof Error ? err : new Error(String(err)));
            return;
          }

          const backoffMs = Math.min(DEEZER_STREAM_MAX_BACKOFF_MS, DEEZER_STREAM_BASE_BACKOFF_MS * (2 ** attempts));
          attempts += 1;
          await this._sleep(backoffMs);
        } finally {
          try {
            activeReader?.releaseLock?.();
          } catch {}
          activeReader = null;
          activeResponseController = null;
        }
      }
    };

    run().catch((err) => {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return out;
  },

  async _startDeezerEncryptedPipeline(streamUrl: string, trackId: unknown, seekSec = 0) {
    const rawStream = this._createDeezerResilientReadable(streamUrl);
    const decryptStream = new DeezerBfStripeDecryptTransform(
      typeof trackId === 'string' || typeof trackId === 'number' ? trackId : null
    );
    this.sourceStream = rawStream;
    this.deezerDecryptStream = decryptStream;

    const ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(seekSec), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.ffmpeg = ffmpeg;

    this._bindPipelineErrorHandler(rawStream, 'deezer.raw');
    this._bindPipelineErrorHandler(decryptStream, 'deezer.decrypt');
    this._bindPipelineErrorHandler(ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(ffmpeg.stdout, 'ffmpeg.stdout');

    rawStream.on('error', () => {
      this.ffmpeg?.kill?.('SIGKILL');
    });
    decryptStream.on('error', () => {
      this.ffmpeg?.kill?.('SIGKILL');
    });

    const ffmpegStdin = ffmpeg.stdin;
    if (!ffmpegStdin) {
      throw new Error('ffmpeg stdin is not available for the Deezer pipeline.');
    }
    rawStream.pipe(decryptStream).pipe(ffmpegStdin);
  },

  async _startDeezerPipeline(track: Partial<Track> | null | undefined, seekSec = 0) {
    const stream = await this._resolveDeezerStreamUrl(track);
    if (stream.cipherType === 'BF_CBC_STRIPE') {
      await this._startDeezerEncryptedPipeline(stream.url, stream.trackId || track?.deezerTrackId, seekSec);
      return;
    }

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(stream.url, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  },
};




