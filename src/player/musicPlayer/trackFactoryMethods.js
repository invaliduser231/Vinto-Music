import { buildTrackId, buildYouTubeThumbnailFromUrl, normalizeThumbnailUrl, toDurationLabel } from './trackUtils.js';

export const trackFactoryMethods = {
  _buildTrack({
    title,
    url,
    duration,
    thumbnailUrl = null,
    requestedBy,
    source,
    artist = null,
    soundcloudTrackId = null,
    audiusTrackId = null,
    deezerTrackId = null,
    deezerPreviewUrl = null,
    deezerFullStreamUrl = null,
    seekStartSec = 0,
  }) {
    const normalizedThumbnail = normalizeThumbnailUrl(thumbnailUrl) ?? buildYouTubeThumbnailFromUrl(url);
    const normalizedDeezerPreview = normalizeThumbnailUrl(deezerPreviewUrl);
    const normalizedDeezerFull = normalizeThumbnailUrl(deezerFullStreamUrl);
    return {
      id: buildTrackId(),
      title: title || 'Unknown title',
      url,
      duration: toDurationLabel(duration),
      thumbnailUrl: normalizedThumbnail,
      requestedBy,
      source,
      artist: artist ? String(artist).slice(0, 128) : null,
      soundcloudTrackId: soundcloudTrackId ? String(soundcloudTrackId) : null,
      audiusTrackId: audiusTrackId ? String(audiusTrackId) : null,
      deezerTrackId: deezerTrackId ? String(deezerTrackId) : null,
      deezerPreviewUrl: normalizedDeezerPreview,
      deezerFullStreamUrl: normalizedDeezerFull,
      queuedAt: Date.now(),
      seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec), 10) || 0),
    };
  },
};
