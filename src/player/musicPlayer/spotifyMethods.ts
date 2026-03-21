import { ValidationError } from '../../core/errors.ts';
import { extractSpotifyEntity, isHttpUrl, pickThumbnailUrlFromItem } from './trackUtils.ts';
import type { Track } from '../../types/domain.ts';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1/';
const SPOTIFY_PREVIEW_LENGTH_MS = 30_000;

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type SpotifyArtistLike = { name?: unknown };
type SpotifyExternalUrls = { spotify?: unknown } | null | undefined;
type SpotifyTrackLike = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  artists?: unknown;
  external_urls?: SpotifyExternalUrls;
  href?: unknown;
  preview_url?: unknown;
  duration_ms?: unknown;
  album?: unknown;
  track?: unknown;
  is_local?: unknown;
};

function toArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function parseSpotifyArtists(value: unknown): string[] {
  return toArray<SpotifyArtistLike>(value)
    .map((entry) => String(entry?.name ?? '').trim())
    .filter(Boolean);
}

function normalizeSpotifyDurationMs(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SPOTIFY_PREVIEW_LENGTH_MS;
}

function isSpotifyNotFoundError(err: unknown): boolean {
  return Number((err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined) ?? NaN) === 404;
}

type SpotifyApiError = Error & {
  status?: number | null;
  endpoint?: string;
};

export const spotifyMethods: LooseMethodMap = {
  async _getSpotifyAccessToken() {
    const now = Date.now();
    if (this._spotifyAccessToken && this._spotifyAccessTokenExpiresAtMs > (now + 5_000)) {
      return this._spotifyAccessToken;
    }

    let response = null;
    if (this.spotifyClientId && this.spotifyClientSecret && this.spotifyRefreshToken) {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.spotifyRefreshToken,
      });
      const basic = Buffer.from(`${this.spotifyClientId}:${this.spotifyClientSecret}`, 'utf8').toString('base64');
      response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
    } else if (this.spotifyClientId && this.spotifyClientSecret) {
      const body = new URLSearchParams({ grant_type: 'client_credentials' });
      const basic = Buffer.from(`${this.spotifyClientId}:${this.spotifyClientSecret}`, 'utf8').toString('base64');
      response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
    } else {
      throw new ValidationError('Spotify import requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
    }

    if (!response?.ok) {
      throw new Error(`Spotify token request failed (${response?.status ?? 'network'})`);
    }

    const payload = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    const accessToken = String(payload?.access_token ?? '').trim();
    const expiresInSec = Number.parseInt(String(payload?.expires_in ?? ''), 10);
    if (!accessToken) {
      throw new Error('Spotify token response did not include access_token.');
    }

    this._spotifyAccessToken = accessToken;
    this._spotifyAccessTokenExpiresAtMs = now + (Number.isFinite(expiresInSec) ? expiresInSec * 1000 : 3_000_000);
    return accessToken;
  },

  async _spotifyApiRequest(pathname: string, query: Record<string, unknown> = {}) {
    const token = await this._getSpotifyAccessToken();
    const normalizedPath = String(pathname ?? '').replace(/^\/+/, '');
    const endpoint = new URL(normalizedPath, SPOTIFY_API_BASE);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null) continue;
      endpoint.searchParams.set(key, String(value));
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      const error = new Error(`Spotify API request failed (${response?.status ?? 'network'}): ${endpoint.pathname}`) as SpotifyApiError;
      error.status = response?.status ?? null;
      error.endpoint = endpoint.toString();
      throw error;
    }
    return response.json();
  },

  async _spotifyApiRequestWithMarketFallback(pathname: string, market: string | null = null) {
    const normalizedMarket = String(market ?? '').trim().toUpperCase() || null;
    if (!normalizedMarket) {
      return this._spotifyApiRequest(pathname);
    }

    try {
      return await this._spotifyApiRequest(pathname, { market: normalizedMarket });
    } catch (err) {
      if (!isSpotifyNotFoundError(err)) throw err;
      this.logger?.warn?.('Spotify request failed for configured market, retrying without market', {
        market: normalizedMarket,
        pathname,
      });
    }

    return this._spotifyApiRequest(pathname);
  },

  _buildSpotifyMetadataTrack(meta: Record<string, unknown> | null | undefined, requestedBy: string | null, source = 'spotify') {
    const typedMeta = meta as SpotifyTrackLike | null | undefined;
    const artists = parseSpotifyArtists(typedMeta?.artists);
    const artist = artists.join(', ') || null;
    const spotifyTrackId = String(typedMeta?.id ?? '').trim() || null;
    const spotifyUrl = String(typedMeta?.external_urls?.spotify ?? typedMeta?.href ?? '').trim();
    const previewUrl = String(typedMeta?.preview_url ?? '').trim() || null;
    const durationMs = normalizeSpotifyDurationMs(typedMeta?.duration_ms);

    return this._buildTrack({
      title: String(typedMeta?.name ?? 'Spotify track').trim() || 'Spotify track',
      url: spotifyUrl || `https://open.spotify.com/track/${encodeURIComponent(spotifyTrackId ?? 'unknown')}`,
      duration: Math.floor(durationMs / 1000),
      thumbnailUrl: pickThumbnailUrlFromItem(typedMeta?.album ?? typedMeta),
      requestedBy,
      source,
      artist,
      spotifyTrackId,
      spotifyPreviewUrl: isHttpUrl(previewUrl) ? previewUrl : null,
      isPreview: false,
    });
  },

  _pickMirrorSearchQuery(track: Partial<Track> | null | undefined): string {
    const artist = String(track?.artist ?? '').trim();
    const title = String(track?.title ?? '').trim();
    if (artist && title) return `${artist} - ${title}`;
    return title || artist || '';
  },

  _isLikelySameArtist(left: unknown, right: unknown): boolean {
    const a = String(left ?? '').trim().toLowerCase();
    const b = String(right ?? '').trim().toLowerCase();
    if (!a || !b) return false;
    return a.includes(b) || b.includes(a);
  },

  _durationDeltaSeconds(left: unknown, right: unknown): number {
    const toSec = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
      const raw = String(value ?? '').trim();
      if (!raw) return NaN;
      const parts = raw.split(':').map((part) => Number.parseInt(part, 10));
      if (!parts.every((part) => Number.isFinite(part))) return NaN;
      if (parts.length === 2) return ((parts[0] ?? 0) * 60) + (parts[1] ?? 0);
      if (parts.length === 3) return ((parts[0] ?? 0) * 3600) + ((parts[1] ?? 0) * 60) + (parts[2] ?? 0);
      return NaN;
    };
    const a = toSec(left);
    const b = toSec(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    return Math.abs(a - b);
  },

  _pickBestSpotifyMirror(metadataTrack: Partial<Track> | null | undefined, candidates: unknown) {
    const list = toArray<Track>(candidates);
    if (!list.length) return null;

    for (const candidate of list) {
      if (
        this._isLikelySameArtist(metadataTrack?.artist, candidate?.artist)
        && this._durationDeltaSeconds(metadataTrack?.duration, candidate?.duration) <= 8
      ) {
        return candidate;
      }
    }

    return list[0] ?? null;
  },

  async _resolveSpotifyMirror(metadataTrack: Track, requestedBy: string | null) {
    const query = this._pickMirrorSearchQuery(metadataTrack);
    if (!query) {
      throw new ValidationError('Could not build Spotify mirror search query.');
    }

    const durationInSec = this._parseDurationSeconds?.(metadataTrack.duration)
      ?? Math.floor(normalizeSpotifyDurationMs(metadataTrack.duration) / 1000);

    if (this.deezerArl && this.enableDeezerImport) {
      const deezerMatches = await this._searchDeezerTracks(query, 3, requestedBy).catch(() => []);
      const deezerBest = this._pickBestSpotifyMirror(metadataTrack, deezerMatches);
      if (deezerBest) {
        return [this._cloneTrack(deezerBest, {
          source: `spotify-${deezerBest.source ?? 'deezer-search'}`,
          requestedBy,
          spotifyTrackId: metadataTrack.spotifyTrackId,
          spotifyPreviewUrl: metadataTrack.spotifyPreviewUrl,
        })];
      }
    }

    return this._resolveCrossSourceToYouTube([{
      title: metadataTrack.title,
      artist: metadataTrack.artist,
      durationInSec,
    }], requestedBy, 'spotify');
  },

  async _resolveSpotifyTrack(url: string, requestedBy: string | null) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }

    const entity = extractSpotifyEntity(url);
    if (!entity || entity.type !== 'track') {
      throw new ValidationError('Could not extract Spotify track id from URL.');
    }

    const payload = await this._spotifyApiRequestWithMarketFallback(
      `/tracks/${encodeURIComponent(entity.id)}`,
      this.spotifyMarket || 'US'
    );
    const metadataTrack = this._buildSpotifyMetadataTrack(payload, requestedBy, 'spotify');
    return this._resolveSpotifyMirror(metadataTrack, requestedBy);
  },

  async _resolveSpotifyCollection(url: string, requestedBy: string | null) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }

    const entity = extractSpotifyEntity(url);
    if (!entity || (entity.type !== 'album' && entity.type !== 'playlist')) {
      throw new ValidationError('Could not extract Spotify album/playlist id from URL.');
    }

    const payload = await this._spotifyApiRequestWithMarketFallback(
      `/${entity.type}s/${encodeURIComponent(entity.id)}`,
      this.spotifyMarket || 'US'
    );
    const playlistItems = toArray<SpotifyTrackLike>(payload?.tracks?.items);
    const rawItems: SpotifyTrackLike[] = entity.type === 'playlist'
      ? playlistItems
        .map((item) => item.track as SpotifyTrackLike | null | undefined)
        .filter((item): item is SpotifyTrackLike => Boolean(item))
      : playlistItems;

    const resolved = [];
    for (const item of rawItems.slice(0, this.maxPlaylistTracks)) {
      if (!item?.id || item?.is_local) continue;
      const metadataTrack = this._buildSpotifyMetadataTrack(item, requestedBy, `spotify-${entity.type}`);
      try {
        const mirrored = await this._resolveSpotifyMirror(metadataTrack, requestedBy);
        resolved.push(...mirrored.slice(0, 1));
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Spotify track', {
          spotifyTrackId: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (resolved.length >= this.maxPlaylistTracks) break;
    }

    return resolved;
  },

  async _resolveSpotifyArtist(url: string, requestedBy: string | null) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }

    const entity = extractSpotifyEntity(url);
    if (!entity || entity.type !== 'artist') {
      throw new ValidationError('Could not extract Spotify artist id from URL.');
    }

    const payload = await this._spotifyApiRequest(`/artists/${encodeURIComponent(entity.id)}/top-tracks`, {
      market: this.spotifyMarket || 'US',
    });

    const tracks = [];
    for (const item of toArray<SpotifyTrackLike>(payload?.tracks).slice(0, this.maxPlaylistTracks)) {
      const metadataTrack = this._buildSpotifyMetadataTrack(item, requestedBy, 'spotify-artist');
      try {
        const mirrored = await this._resolveSpotifyMirror(metadataTrack, requestedBy);
        tracks.push(...mirrored.slice(0, 1));
      } catch (err) {
        this.logger?.warn?.('Failed to mirror Spotify artist top track', {
          spotifyTrackId: item?.id ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return tracks;
  },
};




