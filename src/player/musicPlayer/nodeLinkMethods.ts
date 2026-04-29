import { ValidationError } from '../../core/errors.ts';
import { normalizeThumbnailUrl, toDurationLabel } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';
import type { NodeLinkLoadResult, NodeLinkTrackData, NodeLinkTrackInfo } from './NodeLinkClient.ts';

type NodeLinkRuntime = MusicPlayer & {
  _buildTrack(input: Record<string, unknown>): Track;
};

type NodeLinkMethods = {
  _resolveNodeLinkTracks(
    query: string,
    requestedBy: string | null,
    limit?: number | null,
    options?: { searchIdentifier?: string | null }
  ): Promise<Track[]>;
  _nodeLinkLoadResultToTracks(result: NodeLinkLoadResult, requestedBy: string | null, limit?: number | null): Track[];
  _nodeLinkTrackDataToTrack(data: NodeLinkTrackData, requestedBy: string | null): Track | null;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function toTrackArray(value: unknown): NodeLinkTrackData[] {
  return Array.isArray(value) ? value.filter((item): item is NodeLinkTrackData => Boolean(toRecord(item))) : [];
}

function readTracksFromLoadData(loadType: string, data: unknown): NodeLinkTrackData[] {
  if (loadType === 'track' || loadType === 'episode') {
    return toRecord(data) ? [data as NodeLinkTrackData] : [];
  }

  if (loadType === 'search') return toTrackArray(data);

  const dataRecord = toRecord(data);
  if (!dataRecord) return [];
  return toTrackArray(dataRecord.tracks);
}

function normalizeLimit(limit: number | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

function readString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function isLikelyNonPlayableYouTubeUrl(url: string | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isYouTubeHost = hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  if (!isYouTubeHost) return false;
  const path = parsed.pathname.toLowerCase();
  if (path === '/watch') return !parsed.searchParams.has('v');
  return (
    path.startsWith('/channel/')
    || path.startsWith('/@')
    || path.startsWith('/user/')
    || path.startsWith('/c/')
    || path.startsWith('/results')
    || path === '/'
  );
}

function readDurationMs(info: NodeLinkTrackInfo | null | undefined): number | string {
  if (info?.isStream === true) return 'Live';
  const parsed = Number.parseInt(String(info?.length ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'Unknown';
  return Math.floor(parsed / 1000);
}

function readIsrc(info: NodeLinkTrackInfo | null | undefined, pluginInfo: Record<string, unknown> | null | undefined): string | null {
  const candidates = [
    info?.isrc,
    pluginInfo?.isrc,
    toRecord(pluginInfo?.externalIds)?.isrc,
    toRecord(pluginInfo?.external_ids)?.isrc,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length === 12) return normalized;
  }
  return null;
}

function buildNodeLinkInfo(info: NodeLinkTrackInfo | null | undefined, isrc: string | null): Track['nodelinkInfo'] {
  if (!info) return null;
  return {
    identifier: readString(info.identifier),
    sourceName: readString(info.sourceName),
    uri: readString(info.uri),
    isSeekable: typeof info.isSeekable === 'boolean' ? info.isSeekable : null,
    isStream: typeof info.isStream === 'boolean' ? info.isStream : null,
    length: Number.isFinite(Number(info.length)) ? Number(info.length) : null,
    artworkUrl: normalizeThumbnailUrl(info.artworkUrl),
    isrc,
  };
}

export const nodeLinkMethods: NodeLinkMethods & ThisType<NodeLinkRuntime> = {
  async _resolveNodeLinkTracks(query, requestedBy, limit = null, options = {}) {
    if (!this.nodeLinkClient?.enabled) {
      throw new ValidationError('NodeLink is not configured.');
    }

    const result = await this.nodeLinkClient.loadTracks(query, options);
    return this._nodeLinkLoadResultToTracks(result, requestedBy, limit);
  },

  _nodeLinkLoadResultToTracks(result, requestedBy, limit = null) {
    const loadType = String(result?.loadType ?? '').trim().toLowerCase();
    if (!loadType || loadType === 'empty') return [];
    if (loadType === 'error') {
      throw new ValidationError(String(result?.exception?.message ?? 'NodeLink failed to resolve that query.'));
    }

    const safeLimit = normalizeLimit(limit, this.maxPlaylistTracks);
    const items = readTracksFromLoadData(loadType, result?.data).slice(0, safeLimit);
    const tracks = items
      .map((item) => this._nodeLinkTrackDataToTrack(item, requestedBy))
      .filter((track): track is Track => Boolean(track));

    if (!tracks.length) {
      throw new ValidationError('NodeLink did not return playable tracks.');
    }
    return tracks;
  },

  _nodeLinkTrackDataToTrack(data, requestedBy) {
    const info = toRecord(data?.info) as NodeLinkTrackInfo | null;
    const encoded = readString(data?.encoded);
    if (!info || !encoded) return null;

    const title = readString(info.title) ?? 'Unknown title';
    const author = readString(info.author);
    const uri = readString(info.uri) ?? `nodelink:${readString(info.sourceName) ?? 'unknown'}:${readString(info.identifier) ?? encoded.slice(0, 16)}`;
    const sourceName = readString(info.sourceName) ?? 'nodelink';
    if (sourceName === 'youtube' && isLikelyNonPlayableYouTubeUrl(uri)) return null;
    const pluginInfo = toRecord(data?.pluginInfo);
    const isrc = readIsrc(info, pluginInfo);

    return this._buildTrack({
      title,
      url: uri,
      duration: toDurationLabel(readDurationMs(info)),
      thumbnailUrl: normalizeThumbnailUrl(info.artworkUrl),
      requestedBy,
      source: sourceName,
      artist: author,
      isLive: info.isStream === true,
      isrc,
      nodelinkEncodedTrack: encoded,
      nodelinkInfo: buildNodeLinkInfo(info, isrc),
    });
  },
};
