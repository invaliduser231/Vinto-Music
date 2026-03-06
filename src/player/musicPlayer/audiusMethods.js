import { ValidationError } from '../../core/errors.js';
import { isHttpUrl, pickThumbnailUrlFromItem, toAudiusDurationLabel } from './trackUtils.js';

export const audiusMethods = {
  async _audiusApiRequest(pathname, query = {}, timeoutMs = 10_000) {
    const endpoint = new URL(pathname, 'https://api.audius.co/v1');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null) continue;
      endpoint.searchParams.set(key, String(value));
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Audius API request failed (${response?.status ?? 'network'}): ${endpoint.pathname}`);
    }

    return response.json();
  },

  _pickAudiusEntity(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload?.data;
    if (Array.isArray(data)) return data[0] ?? null;
    if (data && typeof data === 'object') return data;
    if (Array.isArray(payload)) return payload[0] ?? null;
    if (payload?.id != null) return payload;
    return null;
  },

  _pickAudiusTrackIdFromTrack(track) {
    const explicit = String(track?.audiusTrackId ?? '').trim();
    if (explicit) return explicit;
    return null;
  },

  _buildAudiusPermalink(meta) {
    const direct = String(meta?.permalink ?? meta?.permalink_url ?? meta?.url ?? '').trim();
    if (direct && isHttpUrl(direct)) return direct;

    const handle = String(meta?.user?.handle ?? '').trim();
    const slug = String(meta?.permalink ?? '').trim();
    if (handle && slug) {
      return `https://audius.co/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
    }

    return null;
  },

  _buildAudiusTrackFromMetadata(meta, requestedBy, source = 'audius-direct') {
    const permalink = this._buildAudiusPermalink(meta);
    if (!permalink) return null;

    const title = String(meta?.title ?? 'Audius track').trim() || 'Audius track';
    const duration = toAudiusDurationLabel(meta?.duration ?? null);
    const artist = String(meta?.user?.name ?? meta?.user?.handle ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta);
    const trackId = meta?.id != null ? String(meta.id) : null;

    return this._buildTrack({
      title,
      url: permalink,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      audiusTrackId: trackId,
    });
  },

  async _resolveAudiusByUrl(url, requestedBy) {
    const payload = await this._audiusApiRequest('/resolve', { url }).catch(() => null);
    const entity = this._pickAudiusEntity(payload);
    if (!entity) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
    }

    const kind = String(entity?.kind ?? '').toLowerCase();
    if (kind === 'playlist' || kind === 'album' || kind === 'system_playlist' || entity?.playlist_name || Array.isArray(entity?.tracks)) {
      return this._resolveAudiusPlaylist(entity, requestedBy, url);
    }

    const track = this._buildAudiusTrackFromMetadata(entity, requestedBy, 'audius-direct');
    if (track) return [track];

    return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
  },

  async _resolveAudiusPlaylist(entity, requestedBy, fallbackUrl = null) {
    const playlistId = String(entity?.id ?? '').trim();
    let tracksRaw = Array.isArray(entity?.tracks) ? entity.tracks : [];

    if ((!tracksRaw || tracksRaw.length === 0) && playlistId) {
      const trackListPayload = await this._audiusApiRequest(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        limit: this.maxPlaylistTracks,
        offset: 0,
      }).catch(() => null);
      tracksRaw = Array.isArray(trackListPayload?.data) ? trackListPayload.data : [];
    }

    const tracks = [];
    for (const entry of tracksRaw) {
      if (tracks.length >= this.maxPlaylistTracks) break;
      const track = this._buildAudiusTrackFromMetadata(entry, requestedBy, 'audius-playlist-direct');
      if (track) tracks.push(track);
    }

    if (tracks.length) return tracks;
    if (fallbackUrl) {
      return this._resolveFromUrlFallbackSearch(fallbackUrl, requestedBy, 'audius-playlist-fallback');
    }
    throw new ValidationError('Could not resolve Audius playlist tracks.');
  },

  async _resolveAudiusStreamUrl(track) {
    const trackId = this._pickAudiusTrackIdFromTrack(track);
    if (!trackId) {
      throw new Error('Missing Audius track id.');
    }

    const payload = await this._audiusApiRequest(`/tracks/${encodeURIComponent(trackId)}/stream`, {
      no_redirect: true,
    }).catch(() => null);

    const directUrl = String(payload?.data?.url ?? payload?.data ?? '').trim();
    if (directUrl && isHttpUrl(directUrl)) return directUrl;
    return `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream`;
  },

  async _startAudiusPipeline(track, seekSec = 0) {
    const streamUrl = await this._resolveAudiusStreamUrl(track);
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  },
};
