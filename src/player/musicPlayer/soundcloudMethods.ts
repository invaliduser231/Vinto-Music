import playdl from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import { isSoundCloudAuthorizationError, soundCloudAuthorizationHelp } from './errorUtils.ts';
import { isHttpUrl, normalizeThumbnailUrl, pickThumbnailUrlFromItem, toSoundCloudDurationLabel } from './trackUtils.ts';
import type { Track } from '../../types/domain.ts';

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type SoundCloudPlaylist = { type: 'playlist'; all_tracks: () => Promise<unknown[]> };
type SoundCloudTranscoding = {
  url?: unknown;
  format?: {
    protocol?: unknown;
  } | null;
};
type SoundCloudTranscodingLookup = {
  url?: unknown;
};
type SoundCloudMetadata = Record<string, unknown> & {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  durationInSec?: unknown;
  permalink_url?: unknown;
  url?: unknown;
  artwork_url?: unknown;
  user?: { username?: unknown } | null;
  publisher_metadata?: { artist?: unknown } | null;
  media?: {
    transcodings?: unknown;
  } | null;
};

export const soundcloudMethods: LooseMethodMap = {
  async _resolveSoundCloudTrack(url: string, requestedBy: string | null) {
    try {
      const direct = await this._resolveSoundCloudTrackDirect(url, requestedBy);
      if (direct.length) return direct;
    } catch (err) {
      this.logger?.warn?.('Direct SoundCloud track resolve failed, falling back to play-dl resolver', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'track') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    return [this._buildSoundCloudTrackFromMetadata(data, requestedBy, 'soundcloud-direct')];
  },

  async _resolveSoundCloudPlaylist(url: string, requestedBy: string | null) {
    try {
      const direct = await this._resolveSoundCloudPlaylistDirect(url, requestedBy);
      if (direct.length) return direct;
    } catch (err) {
      this.logger?.warn?.('Direct SoundCloud playlist resolve failed, falling back to play-dl resolver', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'playlist') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    const tracks = await (data as SoundCloudPlaylist).all_tracks();
    return tracks
      .slice(0, this.maxPlaylistTracks)
      .map((track: unknown) => this._buildSoundCloudTrackFromMetadata(track, requestedBy, 'soundcloud-playlist-direct'))
      .filter(Boolean);
  },

  async _ensureSoundCloudClientId() {
    if (this.soundcloudClientId) return this.soundcloudClientId;
    if (!this.soundcloudAutoClientId) {
      throw new ValidationError('SoundCloud is not configured (missing SOUNDCLOUD_CLIENT_ID).');
    }

    try {
      const clientId = await playdl.getFreeClientID();
      if (!clientId) {
        throw new Error('empty client id');
      }
      this.soundcloudClientId = String(clientId).trim();
      this.soundcloudClientIdResolvedAt = Date.now();
      this.logger?.info?.('Resolved SoundCloud client id for direct playback');
      return this.soundcloudClientId;
    } catch (err) {
      throw new ValidationError(`Failed to resolve SoundCloud client id: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async _soundCloudResolve(url: string) {
    const clientId = await this._ensureSoundCloudClientId();
    const endpoint = new URL('https://api-v2.soundcloud.com/resolve');
    endpoint.searchParams.set('url', String(url));
    endpoint.searchParams.set('client_id', clientId);

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`resolve failed (${response?.status ?? 'network'})`);
    }

    return response.json();
  },

  async _fetchSoundCloudTrackById(trackId: unknown) {
    const clientId = await this._ensureSoundCloudClientId();
    const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${encodeURIComponent(String(trackId))}`);
    endpoint.searchParams.set('client_id', clientId);

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`track lookup failed (${response?.status ?? 'network'})`);
    }

    return response.json();
  },

  async _resolveSoundCloudTranscodingUrl(trackPayload: SoundCloudMetadata | null | undefined) {
    const clientId = await this._ensureSoundCloudClientId();
    const transcodings = Array.isArray(trackPayload?.media?.transcodings)
      ? trackPayload.media.transcodings
      : [];
    if (!transcodings.length) {
      throw new Error('no transcodings in SoundCloud payload');
    }

    const ranked = [
      ...transcodings.filter((entry: SoundCloudTranscoding) => entry?.format?.protocol === 'progressive'),
      ...transcodings.filter((entry: SoundCloudTranscoding) => entry?.format?.protocol === 'hls'),
    ];
    if (!ranked.length) {
      throw new Error('no usable SoundCloud transcodings');
    }

    let lastError = null;
    for (const transcoding of ranked) {
      const lookupUrl = String(transcoding?.url ?? '').trim();
      if (!lookupUrl) continue;

      const endpoint = new URL(lookupUrl);
      endpoint.searchParams.set('client_id', clientId);
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!response?.ok) {
        lastError = new Error(`transcoding lookup failed (${response?.status ?? 'network'})`);
        continue;
      }

      const body = await response.json().catch(() => null) as SoundCloudTranscodingLookup | null;
      const streamUrl = String(body?.url ?? '').trim();
      if (!streamUrl || !isHttpUrl(streamUrl)) {
        lastError = new Error('transcoding lookup returned no stream url');
        continue;
      }
      return streamUrl;
    }

    throw lastError ?? new Error('no playable SoundCloud stream URL');
  },

  _buildSoundCloudTrackFromMetadata(meta: SoundCloudMetadata | null | undefined, requestedBy: string | null, source = 'soundcloud-direct') {
    const permalink = String(meta?.permalink_url ?? meta?.url ?? '').trim();
    if (!permalink || !isHttpUrl(permalink)) return null;

    const title = String(meta?.title ?? 'SoundCloud track').trim() || 'SoundCloud track';
    const duration = toSoundCloudDurationLabel(meta?.duration ?? meta?.durationInSec ?? null);
    const artist = String(meta?.user?.username ?? meta?.publisher_metadata?.artist ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta) ?? normalizeThumbnailUrl(meta?.artwork_url);
    const trackId = meta?.id != null ? String(meta.id) : null;

    return this._buildTrack({
      title,
      url: permalink,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      soundcloudTrackId: trackId,
    });
  },

  async _resolveSoundCloudTrackDirect(url: string, requestedBy: string | null) {
    const payload = await this._soundCloudResolve(url);
    const kind = String(payload?.kind ?? '').toLowerCase();
    if (kind !== 'track') {
      throw new Error(`resolved object is not a track (${kind || 'unknown'})`);
    }

    const track = this._buildSoundCloudTrackFromMetadata(payload, requestedBy, 'soundcloud-direct');
    return track ? [track] : [];
  },

  async _resolveSoundCloudPlaylistDirect(url: string, requestedBy: string | null) {
    const payload = await this._soundCloudResolve(url);
    const kind = String(payload?.kind ?? '').toLowerCase();
    if (kind !== 'playlist' && kind !== 'system-playlist') {
      throw new Error(`resolved object is not a playlist (${kind || 'unknown'})`);
    }

    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    const resolved = [];
    for (const entry of tracks) {
      if (resolved.length >= this.maxPlaylistTracks) break;
      const track = this._buildSoundCloudTrackFromMetadata(entry, requestedBy, 'soundcloud-playlist-direct');
      if (track) resolved.push(track);
    }

    return resolved;
  },

  async _resolveSoundCloudStreamUrl(track: Partial<Track> | null | undefined) {
    const sourceUrl = String(track?.url ?? '').trim();
    const trackId = String(track?.soundcloudTrackId ?? '').trim() || null;

    let payload = null;
    if (trackId) {
      payload = await this._fetchSoundCloudTrackById(trackId).catch(() => null);
    }
    if (!payload && sourceUrl) {
      payload = await this._soundCloudResolve(sourceUrl).catch(() => null);
    }
    if (!payload) {
      throw new Error('SoundCloud track resolve failed');
    }

    return this._resolveSoundCloudTranscodingUrl(payload);
  },

  async _startSoundCloudPipeline(track: Partial<Track> | null | undefined, seekSec = 0) {
    const streamUrl = await this._resolveSoundCloudStreamUrl(track);
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  },
};


