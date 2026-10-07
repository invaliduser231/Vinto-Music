import playdl from 'play-dl';
import type { SoundCloud, SoundCloudPlaylist } from 'play-dl';
import { ValidationError } from '../../core/errors.ts';
import { isSoundCloudAuthorizationError, soundCloudAuthorizationHelp } from './errorUtils.ts';
import { isHttpUrl, normalizeThumbnailUrl, pickThumbnailUrlFromItem, toSoundCloudDurationLabel } from './trackUtils.ts';
import type { Track } from '../../types/domain.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import { asRecord, readField } from '../../utils/unknownData.ts';

export interface SoundCloudMethodMembers {
  _resolveSoundCloudTrack(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveSoundCloudPlaylist(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _ensureSoundCloudClientId(): Promise<string>;
  _soundCloudResolve(url: string): Promise<unknown>;
  _fetchSoundCloudTrackById(trackId: unknown): Promise<unknown>;
  _resolveSoundCloudTranscodingUrl(trackPayload: unknown): Promise<string>;
  _buildSoundCloudTrackFromMetadata(meta: unknown, requestedBy: string | null, source?: string): Track | null;
  _resolveSoundCloudTrackDirect(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveSoundCloudPlaylistDirect(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolveSoundCloudStreamUrl(track: Partial<Track> | null | undefined): Promise<string>;
  _startSoundCloudPipeline(track: Partial<Track> | null | undefined, seekSec?: number): Promise<void>;
}

function isPlayDlSoundCloudPlaylist(data: SoundCloud): data is SoundCloudPlaylist {
  return data.type === 'playlist';
}

export const soundcloudMethods: SoundCloudMethodMembers & ThisType<MusicPlayer> = {
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

    let data: SoundCloud;
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

    const track = this._buildSoundCloudTrackFromMetadata(data, requestedBy, 'soundcloud-direct');
    return track ? [track] : [];
  },

  async _resolveSoundCloudPlaylist(url: string, requestedBy: string | null, limit?: number | null) {
    try {
      const direct = await this._resolveSoundCloudPlaylistDirect(url, requestedBy, limit);
      if (direct.length) return direct;
    } catch (err) {
      this.logger?.warn?.('Direct SoundCloud playlist resolve failed, falling back to play-dl resolver', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let data: SoundCloud;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || !isPlayDlSoundCloudPlaylist(data)) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));
    const tracks: unknown[] = await data.all_tracks();
    return tracks
      .slice(0, safeLimit)
      .map((track) => this._buildSoundCloudTrackFromMetadata(track, requestedBy, 'soundcloud-playlist-direct'))
      .filter((track): track is Track => Boolean(track));
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

  async _resolveSoundCloudTranscodingUrl(trackPayload: unknown) {
    const clientId = await this._ensureSoundCloudClientId();
    const rawTranscodings = readField(readField(trackPayload, 'media'), 'transcodings');
    const transcodings: unknown[] = Array.isArray(rawTranscodings) ? rawTranscodings : [];
    if (!transcodings.length) {
      throw new Error('no transcodings in SoundCloud payload');
    }

    const readProtocol = (entry: unknown): unknown => readField(readField(entry, 'format'), 'protocol');
    const ranked = [
      ...transcodings.filter((entry) => readProtocol(entry) === 'progressive'),
      ...transcodings.filter((entry) => readProtocol(entry) === 'hls'),
    ];
    if (!ranked.length) {
      throw new Error('no usable SoundCloud transcodings');
    }

    let lastError: Error | null = null;
    for (const transcoding of ranked) {
      const lookupUrl = String(readField(transcoding, 'url') ?? '').trim();
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

      const body: unknown = await response.json().catch(() => null);
      const streamUrl = String(readField(body, 'url') ?? '').trim();
      if (!streamUrl || !isHttpUrl(streamUrl)) {
        lastError = new Error('transcoding lookup returned no stream url');
        continue;
      }
      return streamUrl;
    }

    throw lastError ?? new Error('no playable SoundCloud stream URL');
  },

  _buildSoundCloudTrackFromMetadata(meta: unknown, requestedBy: string | null, source = 'soundcloud-direct') {
    const record = asRecord(meta);
    const permalink = String(record?.permalink_url ?? record?.url ?? '').trim();
    if (!permalink || !isHttpUrl(permalink)) return null;

    const title = String(record?.title ?? 'SoundCloud track').trim() || 'SoundCloud track';
    const duration = toSoundCloudDurationLabel(record?.duration ?? record?.durationInSec ?? null);
    const artist = String(readField(record?.user, 'username') ?? readField(record?.publisher_metadata, 'artist') ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta) ?? normalizeThumbnailUrl(record?.artwork_url);
    const trackId = record?.id != null ? String(record.id) : null;

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
    const kind = String(readField(payload, 'kind') ?? '').toLowerCase();
    if (kind !== 'track') {
      throw new Error(`resolved object is not a track (${kind || 'unknown'})`);
    }

    const track = this._buildSoundCloudTrackFromMetadata(payload, requestedBy, 'soundcloud-direct');
    return track ? [track] : [];
  },

  async _resolveSoundCloudPlaylistDirect(url: string, requestedBy: string | null, limit?: number | null) {
    const payload = await this._soundCloudResolve(url);
    const record = asRecord(payload);
    const kind = String(record?.kind ?? '').toLowerCase();
    if (kind !== 'playlist' && kind !== 'system-playlist') {
      throw new Error(`resolved object is not a playlist (${kind || 'unknown'})`);
    }

    const safeLimit = Math.max(1, Math.min(this.maxPlaylistTracks, Number.parseInt(String(limit), 10) || this.maxPlaylistTracks));
    const rawTracks = record?.tracks;
    const tracks: unknown[] = Array.isArray(rawTracks) ? rawTracks : [];
    const resolved: Track[] = [];
    for (const entry of tracks) {
      if (resolved.length >= safeLimit) break;
      const metadata = asRecord(entry);
      const rawTitle = String(metadata?.title ?? '').trim();
      const trackId = metadata?.id ?? null;
      let track = this._buildSoundCloudTrackFromMetadata(metadata, requestedBy, 'soundcloud-playlist-direct');

      // SoundCloud playlist payloads can contain partial track stubs for non-first entries.
      // Rehydrate by id so queue entries keep the real title/url instead of placeholders.
      const shouldHydrateTrack = trackId != null && (!track || !rawTitle || track.title === 'SoundCloud track');
      if (shouldHydrateTrack) {
        const hydrated = await this._fetchSoundCloudTrackById(trackId).catch(() => null);
        if (hydrated) {
          track = this._buildSoundCloudTrackFromMetadata(hydrated, requestedBy, 'soundcloud-playlist-direct');
        }
      }

      if (track) resolved.push(track);
    }

    // SoundCloud's resolve endpoint can return only a small preview of large sets.
    // Let the play-dl fallback enumerate all tracks when the payload is visibly truncated.
    const totalTracks = Number.parseInt(String(record?.track_count ?? record?.tracks_count ?? ''), 10);
    if (Number.isFinite(totalTracks) && totalTracks > resolved.length && resolved.length < safeLimit) {
      throw new Error(`direct playlist payload was truncated (${resolved.length}/${totalTracks})`);
    }

    return resolved;
  },

  async _resolveSoundCloudStreamUrl(track: Partial<Track> | null | undefined) {
    const sourceUrl = String(track?.url ?? '').trim();
    const trackId = String(track?.soundcloudTrackId ?? '').trim() || null;

    let payload: unknown = null;
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
    const ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.ffmpeg = ffmpeg;
    this._bindPipelineErrorHandler(ffmpeg.stdout, 'ffmpeg.stdout');
  },
};
