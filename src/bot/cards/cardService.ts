import { safeFetch } from '../../utils/safeHttp.ts';
import { parseDurationToSeconds } from '../commands/helpers/formatting.ts';
import { knownSourceLabel, sourceColor } from '../messageFormatter.ts';
import { renderNowPlayingCard, type CardLabels, type CardVariant } from './nowPlayingCard.ts';

export type CardStyle = CardVariant | 'off';

export type CardTrack = {
  title?: unknown;
  artist?: unknown;
  duration?: unknown;
  isLive?: unknown;
  source?: unknown;
  thumbnailUrl?: unknown;
};

export type CardFile = {
  filename: string;
  contentType: string;
  data: Uint8Array;
};

const COVER_TIMEOUT_MS = 4_000;
const COVER_MAX_BYTES = 4 * 1024 * 1024;
const COVER_CACHE_TTL_MS = 10 * 60_000;
const COVER_CACHE_MAX = 64;

const NOISE_SEGMENT = /\s*[([](?:[^)\]]*?\b(?:official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|mv|clip|explicit)\b[^)\]]*)[)\]]/gi;
const ARTIST_SUFFIX = /\s*(?:-\s*topic|vevo|official)$/i;

const coverCache = new Map<string, { data: Uint8Array | null; expiresAt: number }>();

export function resolveCardStyle(value: unknown, fallback: CardStyle = 'ambient'): CardStyle {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'ambient' || normalized === 'split' || normalized === 'vinyl' || normalized === 'off') return normalized;
  return fallback;
}

export function cleanDisplayArtist(value: unknown): string {
  return String(value ?? '').trim().replace(ARTIST_SUFFIX, '').trim();
}

export function cleanDisplayTitle(title: unknown, artist: unknown): string {
  let output = String(title ?? '').replace(NOISE_SEGMENT, '').replace(/\s{2,}/g, ' ').trim();
  const cleanArtist = cleanDisplayArtist(artist);
  if (cleanArtist) {
    const prefix = new RegExp(`^${cleanArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–:|]\\s*`, 'i');
    const stripped = output.replace(prefix, '').trim();
    if (stripped) output = stripped;
  }
  return output || String(title ?? '').trim();
}

export function isLetterboxedThumbnail(url: string): boolean {
  return /(^|\.)ytimg\.com\//i.test(url.replace(/^https?:\/\//i, '')) && /\/(hq|mq|sd)?default\.jpg/i.test(url);
}

async function loadCover(url: string): Promise<Uint8Array | null> {
  const now = Date.now();
  const cached = coverCache.get(url);
  if (cached && cached.expiresAt > now) return cached.data;

  const data = await safeFetch(url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) return null;
      const type = String(response.headers.get('content-type') ?? '').toLowerCase();
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!type.startsWith('image/') || length > COVER_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      return buffer.byteLength > COVER_MAX_BYTES ? null : buffer;
    })
    .catch(() => null);

  coverCache.set(url, { data, expiresAt: now + COVER_CACHE_TTL_MS });
  while (coverCache.size > COVER_CACHE_MAX) {
    const oldest = coverCache.keys().next().value;
    if (oldest === undefined) break;
    coverCache.delete(oldest);
  }
  return data;
}

export async function buildNowPlayingCardFile(
  track: CardTrack,
  options: {
    style: CardStyle;
    positionSec?: number;
    upNext?: CardTrack | null;
    queueLength?: number;
    labels?: Partial<CardLabels>;
  },
): Promise<CardFile | null> {
  if (options.style === 'off') return null;

  const artist = cleanDisplayArtist(track.artist);
  const title = cleanDisplayTitle(track.title, track.artist);
  if (!title) return null;

  const durationSec = typeof track.duration === 'number'
    ? track.duration
    : parseDurationToSeconds(track.duration);
  const thumbnailUrl = String(track.thumbnailUrl ?? '').trim();
  const cover = /^https?:\/\//i.test(thumbnailUrl) ? await loadCover(thumbnailUrl) : null;
  const upNext = options.upNext
    ? [cleanDisplayArtist(options.upNext.artist), cleanDisplayTitle(options.upNext.title, options.upNext.artist)]
      .filter(Boolean)
      .join(' - ')
    : null;
  const source = String(track.source ?? '').trim();

  const png = await renderNowPlayingCard({
    title,
    artist: artist || null,
    durationSec: durationSec ?? null,
    positionSec: options.positionSec ?? 0,
    isLive: track.isLive === true,
    sourceLabel: knownSourceLabel(source),
    accentColor: sourceColor(source),
    upNext,
    queueLength: options.queueLength ?? 0,
    cover,
    coverIsLetterboxed: isLetterboxedThumbnail(thumbnailUrl),
    ...(options.labels ? { labels: options.labels } : {}),
  }, options.style).catch(() => null);

  if (!png) return null;
  return { filename: 'now-playing.png', contentType: 'image/png', data: new Uint8Array(png) };
}

export function _clearCoverCache(): void {
  coverCache.clear();
}
