import { ValidationError } from '../../core/errors.ts';
import { isHttpUrl, pickThumbnailUrlFromItem, toAudiusDurationLabel } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { PipelineProcess, Track } from '../../types/domain.ts';

type AudiusPayloadObject = { data?: unknown; id?: unknown } & Record<string, unknown>;
type AudiusApiPayload = AudiusPayloadObject | unknown[] | null;
type AudiusEntity = Record<string, unknown> & {
  id?: unknown;
  kind?: unknown;
  tracks?: unknown;
  playlist_name?: unknown;
  user?: { handle?: unknown; name?: unknown } | null;
  permalink?: unknown;
  permalink_url?: unknown;
  url?: unknown;
  title?: unknown;
  duration?: unknown;
};
type AudiusPlayer = MusicPlayer & {
  _buildTrack: (input: Record<string, unknown>) => Track;
  _resolveFromUrlFallbackSearch: (url: string, requestedBy: string | null, source: string) => Promise<Track[]>;
  _spawnProcess: (command: string, args: string[], options: Record<string, unknown>) => Promise<PipelineProcess>;
  _ffmpegHttpArgs: (url: string, seekSec?: number) => string[];
  _bindPipelineErrorHandler: (stream: unknown, label: string) => void;
  _pickAudiusTrackIdFromTrack: (track: Partial<Track> | null | undefined) => string | null;
};
type AudiusMethods = {
  _audiusApiRequest(pathname: string, query?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  _pickAudiusEntity(payload: AudiusApiPayload): AudiusEntity | null;
  _pickAudiusTrackIdFromTrack(track: Partial<Track> | null | undefined): string | null;
  _buildAudiusPermalink(meta: AudiusEntity | null | undefined): string | null;
  _buildAudiusTrackFromMetadata(meta: AudiusEntity | null | undefined, requestedBy: string | null, source?: string): Track | null;
  _resolveAudiusByUrl(url: string, requestedBy: string | null): Promise<Track[]>;
  _resolveAudiusPlaylist(entity: AudiusEntity, requestedBy: string | null, fallbackUrl?: string | null): Promise<Track[]>;
  _resolveAudiusStreamUrl(track: Partial<Track> | null | undefined): Promise<string>;
  _startAudiusPipeline(track: Partial<Track> | null | undefined, seekSec?: number): Promise<void>;
};

export const audiusMethods: AudiusMethods & ThisType<MusicPlayer> = {
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
    const data = !Array.isArray(payload) ? payload.data : undefined;
    if (Array.isArray(data)) return data[0] ?? null;
    if (data && typeof data === 'object') return data;
    if (Array.isArray(payload)) return payload[0] ?? null;
    if (payload.id != null) return payload;
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
    const methods = this as AudiusMethods & AudiusPlayer;
    const permalink = methods._buildAudiusPermalink(meta);
    if (!permalink) return null;

    const title = String(meta?.title ?? 'Audius track').trim() || 'Audius track';
    const duration = toAudiusDurationLabel(meta?.duration ?? null);
    const artist = String(meta?.user?.name ?? meta?.user?.handle ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta);
    const trackId = meta?.id != null ? String(meta.id) : null;

    return methods._buildTrack({
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
    const methods = this as AudiusMethods & AudiusPlayer;
    const payload = await methods._audiusApiRequest('/resolve', { url }).catch(() => null);
    const entity = methods._pickAudiusEntity(payload as AudiusApiPayload);
    if (!entity) {
      return methods._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
    }

    const kind = String(entity?.kind ?? '').toLowerCase();
    if (kind === 'playlist' || kind === 'album' || kind === 'system_playlist' || entity?.playlist_name || Array.isArray(entity?.tracks)) {
      return methods._resolveAudiusPlaylist(entity, requestedBy, url);
    }

    const track = methods._buildAudiusTrackFromMetadata(entity, requestedBy, 'audius-direct');
    if (track) return [track];

    return methods._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
  },

  async _resolveAudiusPlaylist(entity, requestedBy, fallbackUrl = null) {
    const methods = this as AudiusMethods & AudiusPlayer;
    const playlistId = String(entity?.id ?? '').trim();
    let tracksRaw = Array.isArray(entity?.tracks) ? entity.tracks : [];

    if ((!tracksRaw || tracksRaw.length === 0) && playlistId) {
      const trackListPayload = await methods._audiusApiRequest(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        limit: this.maxPlaylistTracks,
        offset: 0,
      }).catch(() => null);
      const trackList = (trackListPayload && typeof trackListPayload === 'object' && !Array.isArray(trackListPayload))
        ? (trackListPayload as AudiusPayloadObject).data
        : undefined;
      tracksRaw = Array.isArray(trackList) ? trackList : [];
    }

    const tracks: Track[] = [];
    for (const entry of tracksRaw) {
      if (tracks.length >= this.maxPlaylistTracks) break;
      const track = methods._buildAudiusTrackFromMetadata(entry as AudiusEntity, requestedBy, 'audius-playlist-direct');
      if (track) tracks.push(track);
    }

    if (tracks.length) return tracks;
    if (fallbackUrl) {
      return methods._resolveFromUrlFallbackSearch(fallbackUrl, requestedBy, 'audius-playlist-fallback');
    }
    throw new ValidationError('Could not resolve Audius playlist tracks.');
  },

  async _resolveAudiusStreamUrl(track) {
    const methods = this as AudiusMethods & AudiusPlayer;
    const trackId = methods._pickAudiusTrackIdFromTrack(track);
    if (!trackId) {
      throw new Error('Missing Audius track id.');
    }

    const payload = await methods._audiusApiRequest(`/tracks/${encodeURIComponent(trackId)}/stream`, {
      no_redirect: true,
    }).catch(() => null);

    const payloadData = (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? (payload as AudiusPayloadObject).data
      : undefined;
    const directUrl = String(
      payloadData && typeof payloadData === 'object' && 'url' in payloadData
        ? (payloadData as { url?: unknown }).url ?? ''
        : payloadData ?? ''
    ).trim();
    if (directUrl && isHttpUrl(directUrl)) return directUrl;
    return `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream`;
  },

  async _startAudiusPipeline(track, seekSec = 0) {
    const methods = this as AudiusMethods & AudiusPlayer;
    const streamUrl = await methods._resolveAudiusStreamUrl(track);
    this.ffmpeg = await methods._spawnProcess(this.ffmpegBin, methods._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    methods._bindPipelineErrorHandler(this.ffmpeg?.stdout, 'ffmpeg.stdout');
  },
};


