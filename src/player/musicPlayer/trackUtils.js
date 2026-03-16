export function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isLikelyPlaylistUrl(value) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.includes('.m3u') || normalized.includes('.m3u8') || normalized.includes('.pls');
}

export function isLikelyDirectAudioFileUrl(value) {
  const normalized = String(value ?? '').toLowerCase();
  return (
    normalized.includes('.mp3')
    || normalized.includes('.m4a')
    || normalized.includes('.aac')
    || normalized.includes('.wav')
    || normalized.includes('.flac')
    || normalized.includes('.ogg')
    || normalized.includes('.opus')
    || normalized.includes('.webm')
  );
}

export function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host.includes('youtu.be')) {
      const segment = String(parsed.pathname ?? '').split('/').filter(Boolean)[0];
      return segment ? segment.trim() : null;
    }

    if (host.includes('youtube.com')) {
      const v = String(parsed.searchParams.get('v') ?? '').trim();
      return v || null;
    }

    return null;
  } catch {
    return null;
  }
}

export function toCanonicalYouTubeWatchUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function inferYouTubeWatchUrlFromPlaylist(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;

    const explicit = toCanonicalYouTubeWatchUrl(value);
    if (explicit) return explicit;

    const listId = String(parsed.searchParams.get('list') ?? '').trim();
    if (!listId || !listId.toUpperCase().startsWith('RD')) return null;

    const match = listId.match(/([A-Za-z0-9_-]{11})$/);
    if (!match?.[1]) return null;

    const videoId = match[1];
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

export function buildYouTubeThumbnailFromUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

export function normalizeYouTubeVideoUrlFromEntry(entry) {
  const webpageUrl = String(entry?.webpage_url ?? '').trim();
  if (webpageUrl && isYouTubeUrl(webpageUrl)) return webpageUrl;

  const rawUrl = String(entry?.url ?? '').trim();
  if (rawUrl && isYouTubeUrl(rawUrl)) return rawUrl;

  const id = String(entry?.id ?? '').trim();
  if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  if (/^[\w-]{6,}$/.test(rawUrl)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(rawUrl)}`;
  }

  return null;
}

export function getYouTubePlaylistId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;
    const list = String(parsed.searchParams.get('list') ?? '').trim();
    return list || null;
  } catch {
    return null;
  }
}

export function toCanonicalYouTubePlaylistUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;

    const listId = String(parsed.searchParams.get('list') ?? '').trim();
    if (!listId) return null;

    const videoId = String(parsed.searchParams.get('v') ?? '').trim();
    const requiresWatchContext = listId.toUpperCase().startsWith('RD')
      || String(parsed.searchParams.get('start_radio') ?? '').trim() === '1';

    if (videoId && requiresWatchContext) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`;
    }

    return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

export function isSoundCloudUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('soundcloud.com') || parsed.hostname.includes('snd.sc') || parsed.hostname.includes('on.soundcloud.com');
  } catch {
    return false;
  }
}

export function isDeezerUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('deezer.com') || parsed.hostname.includes('dzr.page.link');
  } catch {
    return false;
  }
}

export function isSpotifyUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('spotify.com') || parsed.hostname === 'spoti.fi';
  } catch {
    return false;
  }
}

export function isAppleMusicUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'music.apple.com' || host.endsWith('.music.apple.com');
  } catch {
    return false;
  }
}

export function isAmazonMusicUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'music.amazon.com' || /^music\.amazon\.[a-z.]+$/i.test(host);
  } catch {
    return false;
  }
}

export function extractAppleMusicEntity(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'music.apple.com' && !host.endsWith('.music.apple.com')) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    if (!segments.length) return null;

    const knownTypes = new Set(['album', 'playlist', 'artist', 'song']);
    let typeIndex = segments.findIndex((segment) => knownTypes.has(segment.toLowerCase()));
    if (typeIndex < 0 && segments.length >= 2 && /^[a-z]{2}$/i.test(segments[0])) {
      typeIndex = segments.findIndex((segment, index) => index > 0 && knownTypes.has(segment.toLowerCase()));
    }
    if (typeIndex < 0) return null;

    const type = segments[typeIndex].toLowerCase();
    const id = String(segments[typeIndex + 2] ?? segments[segments.length - 1] ?? '').trim();
    const countryCode = /^[a-z]{2}$/i.test(segments[0]) ? segments[0].toUpperCase() : null;
    const trackId = String(parsed.searchParams.get('i') ?? '').trim() || null;
    if (!id) return null;

    return {
      type,
      id,
      countryCode,
      trackId,
    };
  } catch {
    return null;
  }
}

export function extractAmazonMusicEntity(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'music.amazon.com' && !/^music\.amazon\.[a-z.]+$/i.test(host)) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    if (!segments.length) return null;

    const typeMap = new Map([
      ['artists', 'artist'],
      ['artist', 'artist'],
      ['albums', 'album'],
      ['album', 'album'],
      ['playlists', 'playlist'],
      ['playlist', 'playlist'],
      ['user-playlists', 'playlist'],
      ['tracks', 'track'],
      ['track', 'track'],
    ]);

    let type = null;
    let id = null;

    for (let i = 0; i < segments.length; i += 1) {
      const normalized = typeMap.get(segments[i].toLowerCase());
      if (!normalized) continue;
      type = normalized;
      id = String(segments[i + 1] ?? '').trim() || null;
      break;
    }

    const trackId = String(parsed.searchParams.get('trackAsin') ?? '').trim() || null;
    if (trackId) {
      return {
        type: 'track',
        id: trackId,
        trackId,
      };
    }

    if (!type && segments.length === 1) {
      type = 'track';
      id = segments[0];
    }

    if (!type || !id) return null;
    return {
      type,
      id,
      trackId: trackId || null,
    };
  } catch {
    return null;
  }
}

export function extractSpotifyEntity(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host === 'spoti.fi' || host.includes('spotify.link')) {
      return null;
    }

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);

    const types = new Set(['track', 'album', 'playlist', 'artist']);
    const typeIndex = segments.findIndex((segment) => types.has(segment.toLowerCase()));
    if (typeIndex < 0) return null;

    const type = segments[typeIndex].toLowerCase();
    const id = String(segments[typeIndex + 1] ?? '').trim();
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;

    return { type, id };
  } catch {
    return null;
  }
}

export function extractDeezerTrackId(value) {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/track\/(\d+)/i);
    if (match?.[1]) return match[1];

    const isPageLink = parsed.hostname.includes('dzr.page.link');
    if (!isPageLink) return null;

    const deezerUrl = parsed.searchParams.get('link');
    if (!deezerUrl) return null;
    return extractDeezerTrackId(deezerUrl);
  } catch {
    return null;
  }
}

export function isAudiusUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('audius.co');
  } catch {
    return false;
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toDurationLabel(value) {
  if (value == null) return 'Unknown';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const total = Math.max(0, Math.floor(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return String(value);
}

export function toSoundCloudDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

export function toDeezerDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

export function toAudiusDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

export function buildTrackId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function pickArtistName(track) {
  if (Array.isArray(track?.artists) && track.artists[0]?.name) {
    return track.artists[0].name;
  }
  if (track?.artist?.name) return track.artist.name;
  if (track?.user?.name) return track.user.name;
  return null;
}

export function pickTrackArtistFromMetadata(track) {
  const nestedArtist = pickArtistName(track);
  if (nestedArtist) return String(nestedArtist).trim();

  const candidates = [
    track?.artist,
    track?.uploader,
    track?.creator,
    track?.channel?.name,
    track?.channel?.title,
    track?.channelName,
    track?.ownerChannelName,
    track?.author?.name,
    track?.author,
    track?.video_details?.channel?.name,
    track?.video_details?.channel?.title,
    track?.videoDetails?.channel?.name,
    track?.videoDetails?.channel?.title,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }

  return null;
}

export function sanitizeUrlToSearchQuery(url) {
  try {
    const parsed = new URL(url);
    const rawSegments = parsed.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    const ignored = new Set([
      'track', 'tracks', 'album', 'playlist', 'artist', 'user',
      'sets', 'music', 'intl-en', 'intl-de', 'intl-fr',
    ]);

    const meaningful = rawSegments.filter((segment) => !ignored.has(segment.toLowerCase()));
    if (!meaningful.length) return null;

    const queryParts = [];
    const primary = meaningful[meaningful.length - 1];
    const secondary = meaningful.length > 1 ? meaningful[meaningful.length - 2] : null;

    if (secondary && !/^\d+$/.test(secondary)) {
      queryParts.push(secondary);
    }
    if (primary && !/^\d+$/.test(primary)) {
      queryParts.push(primary);
    }

    if (!queryParts.length) return null;

    const normalized = queryParts.join(' ')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || /^\d+$/.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function normalizeThumbnailUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) return null;
  return raw.slice(0, 2048);
}

export function pickThumbnailUrlFromItem(item) {
  if (!item || typeof item !== 'object') return null;

  const directCandidates = [
    item.thumbnail?.url,
    item.thumbnailURL,
    item.thumbnail_url,
    item.thumbnail,
    item.image?.url,
    item.image,
    item.artwork_url,
    item.artworkUrl,
    item.cover_url,
    item.coverUrl,
    item.cover_xl,
    item.cover_big,
    item.cover_medium,
    item.cover_small,
    item.artwork?.url,
    item.artwork?.['1000x1000'],
    item.artwork?.['480x480'],
    item.artwork?.['150x150'],
    item.picture_xl,
    item.picture_big,
    item.picture_medium,
    item.picture_small,
    item.album?.cover_xl,
    item.album?.cover_big,
    item.album?.cover_medium,
    item.album?.cover_small,
    item.album?.cover,
    item.artist?.picture_xl,
    item.artist?.picture_big,
    item.artist?.picture_medium,
    item.artist?.picture_small,
    item.artist?.picture,
    item.profile_picture?.['1000x1000'],
    item.profile_picture?.['480x480'],
    item.profile_picture?.['150x150'],
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeThumbnailUrl(candidate);
    if (normalized) return normalized;
  }

  const listCandidates = [
    item.thumbnails,
    item.images,
    item.video_details?.thumbnails,
    item.videoDetails?.thumbnails,
  ];

  for (const list of listCandidates) {
    if (!Array.isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      const normalized = normalizeThumbnailUrl(entry?.url ?? entry);
      if (normalized) return normalized;
    }
  }

  return null;
}
