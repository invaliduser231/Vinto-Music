import { buildTrackId, buildYouTubeThumbnailFromUrl, normalizeThumbnailUrl, toDurationLabel } from './trackUtils.ts';

type TrackFactoryInput = {
  title: string;
  url: string;
  duration: string | number | null | undefined;
  metadataDeferred?: boolean;
  thumbnailUrl?: string | null;
  requestedBy?: string | null;
  source: string;
  artist?: string | null;
  soundcloudTrackId?: string | null;
  audiusTrackId?: string | null;
  deezerTrackId?: string | null;
  deezerPreviewUrl?: string | null;
  deezerFullStreamUrl?: string | null;
  spotifyTrackId?: string | null;
  spotifyPreviewUrl?: string | null;
  isrc?: string | null;
  nodelinkEncodedTrack?: string | null;
  nodelinkInfo?: Record<string, unknown> | null;
  isPreview?: boolean;
  isLive?: boolean;
  seekStartSec?: number;
};

export const trackFactoryMethods = {
  _buildTrack({
    title,
    url,
    duration,
    metadataDeferred = false,
    thumbnailUrl = null,
    requestedBy,
    source,
    artist = null,
    soundcloudTrackId = null,
    audiusTrackId = null,
    deezerTrackId = null,
    deezerPreviewUrl = null,
    deezerFullStreamUrl = null,
    spotifyTrackId = null,
    spotifyPreviewUrl = null,
    isrc = null,
    nodelinkEncodedTrack = null,
    nodelinkInfo = null,
    isPreview = false,
    isLive = false,
    seekStartSec = 0,
  }: TrackFactoryInput) {
    const normalizedThumbnail = normalizeThumbnailUrl(thumbnailUrl) ?? buildYouTubeThumbnailFromUrl(url);
    const normalizedDeezerPreview = normalizeThumbnailUrl(deezerPreviewUrl);
    const normalizedDeezerFull = normalizeThumbnailUrl(deezerFullStreamUrl);
    const normalizedSpotifyPreview = normalizeThumbnailUrl(spotifyPreviewUrl);
    return {
      id: buildTrackId(),
      title: title || 'Unknown title',
      url,
      duration: toDurationLabel(duration),
      metadataDeferred: Boolean(metadataDeferred),
      thumbnailUrl: normalizedThumbnail,
      requestedBy,
      source,
      artist: artist ? String(artist).slice(0, 128) : null,
      soundcloudTrackId: soundcloudTrackId ? String(soundcloudTrackId) : null,
      audiusTrackId: audiusTrackId ? String(audiusTrackId) : null,
      deezerTrackId: deezerTrackId ? String(deezerTrackId) : null,
      deezerPreviewUrl: normalizedDeezerPreview,
      deezerFullStreamUrl: normalizedDeezerFull,
      spotifyTrackId: spotifyTrackId ? String(spotifyTrackId) : null,
      spotifyPreviewUrl: normalizedSpotifyPreview,
      isrc: isrc ? String(isrc).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || null : null,
      nodelinkEncodedTrack: nodelinkEncodedTrack ? String(nodelinkEncodedTrack) : null,
      nodelinkInfo: nodelinkInfo && typeof nodelinkInfo === 'object' ? { ...nodelinkInfo } : null,
      isPreview: Boolean(isPreview),
      isLive: Boolean(isLive),
      queuedAt: Date.now(),
      seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec), 10) || 0),
    };
  },
};


