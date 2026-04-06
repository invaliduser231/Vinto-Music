type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function readNested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function normalizeHost(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function matchesHost(value: unknown, host: string) {
  const normalized = normalizeHost(value);
  return normalized === host || normalized.endsWith(`.${host}`);
}

export function isHttpUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isLikelyPlaylistUrl(value: unknown) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.includes('.m3u') || normalized.includes('.m3u8') || normalized.includes('.pls');
}

export function isLikelyDirectAudioFileUrl(value: unknown) {
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

export function isYouTubeUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    return matchesHost(parsed.hostname, 'youtube.com') || normalizeHost(parsed.hostname) === 'youtu.be';
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);

    if (host === 'youtu.be') {
      const segment = String(parsed.pathname ?? '').split('/').filter(Boolean)[0];
      return segment ? segment.trim() : null;
    }

    if (matchesHost(host, 'youtube.com')) {
      const v = String(parsed.searchParams.get('v') ?? '').trim();
      return v || null;
    }

    return null;
  } catch {
    return null;
  }
}

export function toCanonicalYouTubeWatchUrl(value: unknown) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function inferYouTubeWatchUrlFromPlaylist(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    if (!matchesHost(host, 'youtube.com') && host !== 'youtu.be') return null;

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

export function buildYouTubeThumbnailFromUrl(value: unknown) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

export function normalizeYouTubeVideoUrlFromEntry(entry: unknown) {
  const record = asRecord(entry);
  const webpageUrl = String(record?.webpage_url ?? '').trim();
  if (webpageUrl && isYouTubeUrl(webpageUrl)) {
    return toCanonicalYouTubeWatchUrl(webpageUrl) ?? webpageUrl;
  }

  const rawUrl = String(record?.url ?? '').trim();
  if (rawUrl && isYouTubeUrl(rawUrl)) {
    return toCanonicalYouTubeWatchUrl(rawUrl) ?? rawUrl;
  }

  const id = String(record?.id ?? '').trim();
  if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  if (/^[\w-]{6,}$/.test(rawUrl)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(rawUrl)}`;
  }

  return null;
}

export function getYouTubePlaylistId(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    if (!matchesHost(host, 'youtube.com') && host !== 'youtu.be') return null;
    const list = String(parsed.searchParams.get('list') ?? '').trim();
    return list || null;
  } catch {
    return null;
  }
}

export function toCanonicalYouTubePlaylistUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    if (!matchesHost(host, 'youtube.com') && host !== 'youtu.be') return null;

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

export function isSoundCloudUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    return matchesHost(host, 'soundcloud.com') || host === 'snd.sc' || host === 'on.soundcloud.com';
  } catch {
    return false;
  }
}

export function isDeezerUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    return matchesHost(host, 'deezer.com') || host === 'dzr.page.link';
  } catch {
    return false;
  }
}

export function isSpotifyUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);
    return matchesHost(host, 'spotify.com') || host === 'spoti.fi';
  } catch {
    return false;
  }
}

export function isAppleMusicUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    return host === 'music.apple.com' || host.endsWith('.music.apple.com');
  } catch {
    return false;
  }
}

export function isAmazonMusicUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    return host === 'music.amazon.com' || /^music\.amazon\.[a-z.]+$/i.test(host);
  } catch {
    return false;
  }
}

export function isTidalUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    return host === 'tidal.com' || host.endsWith('.tidal.com');
  } catch {
    return false;
  }
}

export function isBandcampUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.hostname.toLowerCase().endsWith('.bandcamp.com');
  } catch {
    return false;
  }
}

export function isAudiomackUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.hostname.toLowerCase() === 'audiomack.com' || parsed.hostname.toLowerCase() === 'www.audiomack.com';
  } catch {
    return false;
  }
}

export function isMixcloudUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    return host === 'mixcloud.com' || host.endsWith('.mixcloud.com');
  } catch {
    return false;
  }
}

export function isJioSaavnUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    return host === 'jiosaavn.com' || host === 'www.jiosaavn.com';
  } catch {
    return false;
  }
}

export function extractAppleMusicEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'music.apple.com' && !host.endsWith('.music.apple.com')) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    if (!segments.length) return null;

    const knownTypes = new Set(['album', 'playlist', 'artist', 'song']);
    let typeIndex = segments.findIndex((segment) => knownTypes.has(segment.toLowerCase()));
    if (typeIndex < 0 && segments.length >= 2 && /^[a-z]{2}$/i.test(segments[0] ?? '')) {
      typeIndex = segments.findIndex((segment, index) => index > 0 && knownTypes.has(segment.toLowerCase()));
    }
    if (typeIndex < 0) return null;

    const type = String(segments[typeIndex] ?? '').toLowerCase();
    const id = String(segments[typeIndex + 2] ?? segments[segments.length - 1] ?? '').trim();
    const countryCode = /^[a-z]{2}$/i.test(segments[0] ?? '') ? String(segments[0] ?? '').toUpperCase() : null;
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

export function extractAmazonMusicEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
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
      const normalized = typeMap.get(String(segments[i] ?? '').toLowerCase());
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
      id = segments[0] ?? null;
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

export function extractTidalEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'tidal.com' && !host.endsWith('.tidal.com')) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    if (!segments.length) return null;

    const normalizedSegments = String(segments[0] ?? '').toLowerCase() === 'browse'
      ? segments.slice(1)
      : segments;
    const type = String(normalizedSegments[0] ?? '').toLowerCase();
    const id = String(normalizedSegments[1] ?? '').trim();
    if (!['track', 'album', 'playlist', 'mix'].includes(type) || !id) return null;
    return { type, id };
  } catch {
    return null;
  }
}

export function extractBandcampEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    const match = host.match(/^([^.]+)\.bandcamp\.com$/i);
    const subdomain = match?.[1] ?? null;
    if (!subdomain) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    const type = String(segments[0] ?? '').toLowerCase();
    const slug = String(segments[1] ?? '').trim();
    if (!['track', 'album'].includes(type) || !slug) return null;
    return { type, slug, subdomain };
  } catch {
    return null;
  }
}

export function extractAudiomackEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'audiomack.com' && host !== 'www.audiomack.com') return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    if (segments.length < 2) return null;

    const user = String(segments[0] ?? '').trim();
    const type = String(segments[1] ?? '').toLowerCase();
    const slug = segments.length > 2 ? segments.slice(2).join('/') : null;
    if (!user || !type) return null;
    if (!['song', 'album', 'playlist'].includes(type)) {
      return { user, type: 'profile', slug: slug || null };
    }
    return { user, type, slug: slug || null };
  } catch {
    return null;
  }
}

export function extractMixcloudEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'mixcloud.com' || host.endsWith('.mixcloud.com'))) return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    if (!segments.length) return null;

    const user = String(segments[0] ?? '').trim();
    if (!user) return null;
    if (segments[1]?.toLowerCase() === 'playlists' && segments[2]) {
      return { type: 'playlist', user, slug: String(segments[2]).trim() };
    }
    if (['uploads', 'favorites', 'listens', 'stream'].includes(String(segments[1] ?? '').toLowerCase())) {
      return { type: String(segments[1]).toLowerCase(), user, slug: null };
    }
    if (segments[1]) {
      return { type: 'track', user, slug: String(segments[1]).trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function extractJioSaavnEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'jiosaavn.com' && host !== 'www.jiosaavn.com') return null;

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    if (segments.length < 2) return null;

    const type = String(segments[0] ?? '').toLowerCase();
    const id = String(segments[segments.length - 1] ?? '').trim();
    if (!['album', 'featured', 'song', 's', 'artist'].includes(type) || !id) return null;
    return {
      type: type === 's' && String(segments[1] ?? '').toLowerCase() === 'playlist' ? 'playlist' : type,
      id,
    };
  } catch {
    return null;
  }
}

export function extractSpotifyEntity(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = normalizeHost(parsed.hostname);

    if (host === 'spoti.fi' || host === 'spotify.link' || host.endsWith('.spotify.link')) {
      return null;
    }
    if (!matchesHost(host, 'spotify.com')) {
      return null;
    }

    const segments = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);

    const types = new Set(['track', 'album', 'playlist', 'artist']);
    const typeIndex = segments.findIndex((segment) => types.has(segment.toLowerCase()));
    if (typeIndex < 0) return null;

    const type = String(segments[typeIndex] ?? '').toLowerCase();
    const id = String(segments[typeIndex + 1] ?? '').trim();
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;

    return { type, id };
  } catch {
    return null;
  }
}

export function extractDeezerTrackId(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    const match = parsed.pathname.match(/\/track\/(\d+)/i);
    if (match?.[1]) return match[1];

    const isPageLink = normalizeHost(parsed.hostname) === 'dzr.page.link';
    if (!isPageLink) return null;

    const deezerUrl = parsed.searchParams.get('link');
    if (!deezerUrl) return null;
    return extractDeezerTrackId(deezerUrl);
  } catch {
    return null;
  }
}

export function isAudiusUrl(value: unknown) {
  try {
    const parsed = new URL(String(value ?? ''));
    return matchesHost(parsed.hostname, 'audius.co');
  } catch {
    return false;
  }
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function toDurationLabel(value: unknown) {
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

export function toSoundCloudDurationLabel(value: unknown) {
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

export function toDeezerDurationLabel(value: unknown) {
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

export function toAudiusDurationLabel(value: unknown) {
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

export function pickArtistName(track: unknown) {
  const record = asRecord(track);
  const artists = record?.artists;
  if (Array.isArray(artists)) {
    const first = asRecord(artists[0]);
    const firstName = String(first?.name ?? '').trim();
    if (firstName) return firstName;
  }
  const artistName = String(readNested(record, ['artist', 'name']) ?? '').trim();
  if (artistName) return artistName;
  const userName = String(readNested(record, ['user', 'name']) ?? '').trim();
  if (userName) return userName;
  return null;
}

export function pickTrackArtistFromMetadata(track: unknown) {
  const record = asRecord(track);
  const nestedArtist = pickArtistName(track);
  if (nestedArtist) return String(nestedArtist).trim();

  const candidates = [
    record?.artist,
    record?.uploader,
    record?.creator,
    readNested(record, ['channel', 'name']),
    readNested(record, ['channel', 'title']),
    record?.channelName,
    record?.ownerChannelName,
    readNested(record, ['author', 'name']),
    record?.author,
    readNested(record, ['video_details', 'channel', 'name']),
    readNested(record, ['video_details', 'channel', 'title']),
    readNested(record, ['videoDetails', 'channel', 'name']),
    readNested(record, ['videoDetails', 'channel', 'title']),
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }

  return null;
}

export function sanitizeUrlToSearchQuery(url: unknown) {
  try {
    const parsed = new URL(String(url ?? ''));
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
    const primary = meaningful[meaningful.length - 1] ?? null;
    const secondary = meaningful.length > 1 ? (meaningful[meaningful.length - 2] ?? null) : null;

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

export function normalizeThumbnailUrl(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) return null;
  return raw.slice(0, 2048);
}

export function pickThumbnailUrlFromItem(item: unknown) {
  const record = asRecord(item);
  if (!record) return null;

  const directCandidates = [
    readNested(record, ['thumbnail', 'url']),
    record.thumbnailURL,
    record.thumbnail_url,
    record.thumbnail,
    readNested(record, ['image', 'url']),
    record.image,
    record.artwork_url,
    record.artworkUrl,
    record.cover_url,
    record.coverUrl,
    record.cover_xl,
    record.cover_big,
    record.cover_medium,
    record.cover_small,
    readNested(record, ['artwork', 'url']),
    readNested(record, ['artwork', '1000x1000']),
    readNested(record, ['artwork', '480x480']),
    readNested(record, ['artwork', '150x150']),
    record.picture_xl,
    record.picture_big,
    record.picture_medium,
    record.picture_small,
    readNested(record, ['album', 'cover_xl']),
    readNested(record, ['album', 'cover_big']),
    readNested(record, ['album', 'cover_medium']),
    readNested(record, ['album', 'cover_small']),
    readNested(record, ['album', 'cover']),
    readNested(record, ['artist', 'picture_xl']),
    readNested(record, ['artist', 'picture_big']),
    readNested(record, ['artist', 'picture_medium']),
    readNested(record, ['artist', 'picture_small']),
    readNested(record, ['artist', 'picture']),
    readNested(record, ['profile_picture', '1000x1000']),
    readNested(record, ['profile_picture', '480x480']),
    readNested(record, ['profile_picture', '150x150']),
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeThumbnailUrl(candidate);
    if (normalized) return normalized;
  }

  const listCandidates = [
    record.thumbnails,
    record.images,
    readNested(record, ['video_details', 'thumbnails']),
    readNested(record, ['videoDetails', 'thumbnails']),
  ];

  for (const list of listCandidates) {
    if (!Array.isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      const normalized = normalizeThumbnailUrl(readNested(entry, ['url']) ?? entry);
      if (normalized) return normalized;
    }
  }

  return null;
}


