import { normalizeMirrorText, toMirrorSeconds } from '../../player/musicPlayer/mirrorMatch.ts';

const NOISE_PATTERNS: RegExp[] = [
  /\s*[[(](?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|visualiser|lyric(?:s)?(?:\s+video)?|mv|m\/v|hd|hq|4k|8k|full\s+album|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|color\s+coded)[\])]\s*/gi,
  /\s*[[(](?:free|no\s+copyright|copyright\s+free|ncs\s+release|monstercat\s+release)[^)\]]*[\])]\s*/gi,
  /\s+[-|]\s+(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyric(?:s)?(?:\s+video)?)\s*$/gi,
];

const SEPARATORS = [' - ', ' – ', ' — ', ' － ', ' ~ ', ' | '];

const ARTIST_SUFFIX = /\s*[-–]\s*topic$/i;

const SCROBBLE_BLOCKED_SOURCES = new Set(['radio', 'stream', 'livestream', 'file']);

export interface LastFmTrackMetadata {
  artist: string;
  track: string;
  album: string | null;
  durationSec: number;
}

export interface ScrobbleCandidateTrack {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: string | number | null;
  source?: string | null;
  isLive?: boolean | null;
  isPreview?: boolean | null;
  metadataDeferred?: boolean | null;
  [key: string]: unknown;
}

function stripNoise(value: string): string {
  let cleaned = value;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

function normalizeArtist(value: unknown): string {
  return String(value ?? '')
    .replace(ARTIST_SUFFIX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function splitTitle(title: string): { artist: string; track: string } | null {
  for (const separator of SEPARATORS) {
    const index = title.indexOf(separator);
    if (index <= 0) continue;

    const artist = normalizeArtist(title.slice(0, index));
    const track = title.slice(index + separator.length).trim();
    if (artist && track) return { artist, track };
  }
  return null;
}

export function isScrobblableSource(source: unknown): boolean {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return !SCROBBLE_BLOCKED_SOURCES.has(normalized);
}

export function toLastFmTrack(
  track: ScrobbleCandidateTrack | null | undefined,
  options: { minDurationSec?: number } = {},
): LastFmTrackMetadata | null {
  if (!track) return null;
  if (track.isLive || track.isPreview || track.metadataDeferred) return null;
  if (!isScrobblableSource(track.source)) return null;

  const rawTitle = stripNoise(String(track.title ?? '').trim());
  if (!rawTitle || rawTitle.toLowerCase() === 'unknown title') return null;
  if (rawTitle === 'YouTube Mix Track') return null;

  const explicitArtist = normalizeArtist(track.artist);
  let artist = explicitArtist;
  let title = rawTitle;

  if (!artist) {
    const split = splitTitle(rawTitle);
    if (!split) return null;
    artist = split.artist;
    title = split.track;
  } else {
    const split = splitTitle(rawTitle);
    if (split && split.artist.toLowerCase() === artist.toLowerCase()) {
      title = split.track;
    }
  }

  title = stripNoise(title);
  if (!artist || !title) return null;

  const durationSec = toMirrorSeconds(track.duration);
  const minDurationSec = Math.max(1, options.minDurationSec ?? 30);
  if (!durationSec || durationSec < minDurationSec) return null;

  const album = String(track.album ?? '').trim();

  return {
    artist: artist.slice(0, 256),
    track: title.slice(0, 256),
    album: album ? album.slice(0, 256) : null,
    durationSec,
  };
}

export function trackIdentity(meta: Pick<LastFmTrackMetadata, 'artist' | 'track'>): string {
  return `${normalizeMirrorText(meta.artist)} ${normalizeMirrorText(meta.track)}`.trim();
}
