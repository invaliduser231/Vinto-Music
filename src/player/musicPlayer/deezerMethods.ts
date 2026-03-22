import { PassThrough } from 'node:stream';
import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import type { Track } from '../../types/domain.ts';
import {
  buildDeezerLegacyDownloadUrl,
  DeezerBfStripeDecryptTransform,
  DEEZER_MEDIA_QUALITY_MAP,
  DEEZER_SESSION_TOKEN_TTL_MS,
  DEEZER_STREAM_BASE_BACKOFF_MS,
  DEEZER_STREAM_HIGH_WATER_MARK,
  DEEZER_STREAM_MAX_BACKOFF_MS,
  DEEZER_STREAM_RETRY_LIMIT,
  isRetryableDeezerStreamError,
  parseContentRangeStart,
} from './deezer.ts';
import { extractDeezerTrackId, isHttpUrl, pickThumbnailUrlFromItem, toDeezerDurationLabel } from './trackUtils.ts';

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type DeezerPlayableCollection = {
  all_tracks: () => Promise<unknown[]>;
  type: 'playlist' | 'album';
};
type DeezerResponseLike = {
  headers?: {
    getSetCookie?: () => string[];
    get?: (name: string) => string | null;
  } | null;
};

type DeezerTrackMeta = Record<string, unknown> & {
  id?: unknown;
  title?: unknown;
  artist?: { name?: unknown } | null;
  duration?: unknown;
  link?: unknown;
  preview?: unknown;
};

export const deezerMethods: LooseMethodMap = {
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
    if (!data || (data.type !== 'playlist' && data.type !== 'album')) return [];

    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));
    const tracks = await (data as DeezerPlayableCollection).all_tracks();
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

  _buildDeezerTrackFromMetadata(meta: DeezerTrackMeta, requestedBy: string | null, source = 'deezer-direct') {
    const trackId = String(meta?.id ?? '').trim();
    if (!trackId) return null;

    const title = String(meta?.title ?? 'Deezer track').trim() || 'Deezer track';
    const artist = String(meta?.artist?.name ?? '').trim() || null;
    const duration = toDeezerDurationLabel(meta?.duration ?? null);
    const deezerUrl = String(meta?.link ?? '').trim() || `https://www.deezer.com/track/${encodeURIComponent(trackId)}`;
    const previewUrl = String(meta?.preview ?? '').trim() || null;
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
    let payload = null;
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

    const rawTracks = Array.isArray(payload?.tracks?.data) ? payload.tracks.data : [];
    const tracks: unknown[] = [];
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

    const body = await response.json() as Record<string, unknown>;
    const deezerError = this._extractDeezerError(body.error);
    if (deezerError) {
      throw new Error(`Deezer gateway ${method} returned error: ${deezerError}`);
    }
    return body;
  },

  _getDeezerCookieHeader(): string {
    return this._deezerCookieHeader || `arl=${this.deezerArl}`;
  },

  _updateDeezerCookieHeader(response: DeezerResponseLike | null | undefined) {
    if (!response?.headers || !this.deezerArl) return;

    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (() => {
          const single = response.headers.get?.('set-cookie') ?? null;
          return single ? [single] : [];
        })();

    const cookieMap = new Map();
    for (const pair of String(this._deezerCookieHeader || `arl=${this.deezerArl}`).split(';')) {
      const segment = pair.trim();
      if (!segment) continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (key && value) cookieMap.set(key, value);
    }
    if (!cookieMap.has('arl')) {
      cookieMap.set('arl', this.deezerArl);
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
    const results = userData?.results ?? {};
    const apiToken = String(results?.checkForm ?? '').trim();
    const licenseToken = String(results?.USER?.OPTIONS?.license_token ?? results?.OPTIONS?.license_token ?? '').trim();
    if (!apiToken || !licenseToken) {
      throw new Error('Deezer ARL session did not provide API/license tokens.');
    }

    this._deezerSessionTokens = {
      apiToken,
      licenseToken,
      sessionId: this._readDeezerCookieValue('sid'),
      dzrUniqId: this._readDeezerCookieValue('dzr_uniq_id'),
      expiresAtMs: now + DEEZER_SESSION_TOKEN_TTL_MS,
    };
    return this._deezerSessionTokens;
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
      const entries = Object.entries(errorValue);
      if (!entries.length) return null;
      const [key, val] = entries[0]!;
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
    const typedBody = body && typeof body === 'object' ? body as { data?: unknown } : null;
    const firstItem = Array.isArray(typedBody?.data) ? typedBody.data[0] : null;
    const firstMedia = Array.isArray(firstItem?.media) ? firstItem.media[0] : null;
    if (!firstMedia || typeof firstMedia !== 'object') return null;

    const firstSource = Array.isArray(firstMedia.sources) ? firstMedia.sources[0] : null;
    let selectedSource = firstSource ?? null;
    let url = String(selectedSource?.url ?? '').trim();
    if (!isHttpUrl(url) && Array.isArray(firstMedia.sources)) {
      selectedSource = firstMedia.sources.find((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return false;
        const url = String((entry as { url?: unknown }).url ?? '').trim();
        return isHttpUrl(url);
      }) ?? null;
      url = String(selectedSource?.url ?? '').trim();
    }
    if (!isHttpUrl(url)) return null;

    return {
      url,
      cipherType: String(firstMedia?.cipher?.type ?? firstMedia?.cipher ?? 'BF_CBC_STRIPE').trim().toUpperCase() || 'BF_CBC_STRIPE',
      format: String(firstMedia?.format ?? selectedSource?.format ?? '').trim().toUpperCase() || null,
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

  async _resolveDeezerSongData(apiToken: unknown, trackId: unknown) {
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
      const results = payload?.results ?? {};
      const dataCandidate = results?.DATA ?? results?.data?.[0] ?? results ?? null;
      const md5Origin = String(dataCandidate?.MD5_ORIGIN ?? '').trim();
      const songId = String(dataCandidate?.SNG_ID ?? safeTrackId).trim();
      const mediaVersion = String(dataCandidate?.MEDIA_VERSION ?? '').trim();

      if (md5Origin && songId && mediaVersion) {
        return { MD5_ORIGIN: md5Origin, SNG_ID: songId, MEDIA_VERSION: mediaVersion };
      }
    }

    return null;
  },

  async _resolveDeezerLegacyEncryptedStreamUrl(apiToken: unknown, trackId: unknown, preferredFormat: unknown = null) {
    const track = await this._resolveDeezerSongData(apiToken, trackId);
    if (!track) return null;

    const preferred = this._pickDeezerPreferredFormat(preferredFormat);
    const qualityOrder = [preferred, 'MP3_320', 'MP3_128', 'FLAC'];
    const seen = new Set();

    for (const format of qualityOrder) {
      if (seen.has(format)) continue;
      seen.add(format);
      const quality = DEEZER_MEDIA_QUALITY_MAP.get(format);
      if (!quality) continue;
      const url = buildDeezerLegacyDownloadUrl(track, quality);
      if (isHttpUrl(url)) {
        return { url, cipherType: 'BF_CBC_STRIPE', format };
      }
    }

    return null;
  },

  async _resolveDeezerFullStreamUrlWithArl(trackId) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) {
      throw new Error('Missing Deezer track id.');
    }

    const formats = this.deezerTrackFormats.map((format: string) => ({ cipher: 'BF_CBC_STRIPE', format }));
    let lastMediaError = null;

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

      const body = await response.json().catch(() => null);
      const variant = this._resolveDeezerMediaVariantFromResponse(body);
      if (variant?.url) {
        this._deezerStreamMetaByTrackId.set(safeTrackId, {
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
      this._deezerStreamMetaByTrackId.set(safeTrackId, {
        url: legacy.url,
        cipherType: legacy.cipherType || 'BF_CBC_STRIPE',
        format: legacy.format || null,
      });
      return legacy.url;
    }

    throw lastMediaError ?? new Error('No Deezer stream URL available from media API or legacy fallback.');
  },

  async _resolveDeezerTrackToken(apiToken: unknown, trackId: unknown) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) return null;

    const payload = await this._deezerGatewayCall('song.getData', apiToken, { sng_id: safeTrackId }).catch(() => null);
    if (!payload) return null;

    const direct = String(payload?.results?.TRACK_TOKEN ?? '').trim();
    if (direct) return direct;

    const recursive = this._extractFirstStringByKey(payload?.results ?? payload, 'TRACK_TOKEN');
    return recursive || null;
  },

  async _resolveDeezerStreamUrl(track: Partial<Track> | null | undefined) {
    const trackId = String(track?.deezerTrackId ?? '').trim();
    const pinned = String(track?.deezerFullStreamUrl ?? '').trim();
    const cachedMeta = (trackId ? this._deezerStreamMetaByTrackId.get(trackId) : null) as
      | { url?: string; cipherType?: string; format?: string | null }
      | null;

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
    await new Promise((resolve) => setTimeout(resolve, waitMs));
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

    const response = await fetch(streamUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);

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

    return response;
  },

  _createDeezerResilientReadable(streamUrl: string) {
    const out = new PassThrough({ highWaterMark: DEEZER_STREAM_HIGH_WATER_MARK });
    let offset = 0;
    let attempts = 0;
    let closed = false;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const onClose = () => {
      closed = true;
      try {
        activeReader?.cancel?.();
      } catch {}
    };
    out.once('close', onClose);
    out.once('error', onClose);

    const run = async () => {
      while (!closed) {
        let response;
        try {
          response = await this._openDeezerStreamConnection(streamUrl, offset);
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
        activeReader = response.body?.getReader?.() ?? null;
        if (!activeReader) {
          out.destroy(new Error('Encrypted Deezer response body is not readable.'));
          return;
        }

        try {
          while (!closed) {
            const { done, value } = await activeReader.read();
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

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(seekSec), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(rawStream, 'deezer.raw');
    this._bindPipelineErrorHandler(decryptStream, 'deezer.decrypt');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    rawStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });
    decryptStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });

    rawStream.pipe(decryptStream).pipe(this.ffmpeg.stdin);
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




