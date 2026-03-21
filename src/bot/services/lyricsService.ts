function splitArtistTitle(query: unknown): { artist: string; title: string } {
  const raw = String(query ?? '').trim();
  if (!raw) return { artist: '', title: '' };

  const separators = [' - ', ' – ', ' — ', ':'];
  for (const sep of separators) {
    if (!raw.includes(sep)) continue;
    const [left, ...rest] = raw.split(sep);
    const right = rest.join(sep).trim();
    const safeLeft = String(left ?? '').trim();
    if (!safeLeft || !right) continue;
    return { artist: safeLeft, title: right };
  }

  return { artist: '', title: raw };
}

function normalizeMatchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSimilarity(left: unknown, right: unknown): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;

  const aTokens = new Set(a.split(' ').filter(Boolean));
  const bTokens = new Set(b.split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function getLyricsCandidateTrackName(item: unknown): string {
  const typed = (item ?? {}) as Record<string, unknown>;
  return String(
    typed.trackName
    ?? typed.track_name
    ?? typed.name
    ?? typed.title
    ?? ''
  ).trim();
}

function getLyricsCandidateArtistName(item: unknown): string {
  const typed = (item ?? {}) as Record<string, unknown>;
  return String(
    typed.artistName
    ?? typed.artist_name
    ?? typed.artist
    ?? ''
  ).trim();
}

function scoreLyricsCandidate(item: unknown, search: { title?: unknown; artist?: unknown; query?: unknown }): number {
  const title = String(search?.title ?? '').trim();
  const artist = String(search?.artist ?? '').trim();
  const query = String(search?.query ?? '').trim();

  const candidateTitle = getLyricsCandidateTrackName(item);
  const candidateArtist = getLyricsCandidateArtistName(item);
  const candidateFull = [candidateArtist, candidateTitle].filter(Boolean).join(' - ');

  let score = 0;
  if (title) score += tokenSimilarity(title, candidateTitle) * 1.2;
  if (artist) score += tokenSimilarity(artist, candidateArtist) * 1.0;
  if (query) score += tokenSimilarity(query, candidateFull || candidateTitle || candidateArtist) * 0.8;
  if (!artist && !title && query) {
    score += tokenSimilarity(query, candidateTitle) * 0.6;
  }

  const normalizedExpected = normalizeMatchText([artist, title].filter(Boolean).join(' - '));
  const normalizedCandidate = normalizeMatchText(candidateFull);
  if (normalizedExpected && normalizedCandidate && normalizedExpected === normalizedCandidate) {
    score += 0.6;
  }

  return score;
}

function pickBestLyricsCandidate(items: unknown[], search: { title?: unknown; artist?: unknown; query?: unknown }) {
  let best: { score: number; item: unknown; lyrics: string } | null = null;

  for (const item of items) {
    const lyrics = normalizeLyrics((item as { plainLyrics?: unknown } | null | undefined)?.plainLyrics);
    if (!lyrics) continue;

    const score = scoreLyricsCandidate(item, search);
    if (!best || score > best.score) {
      best = { score, item, lyrics };
    }
  }

  if (!best) return null;

  const minScore = search?.artist || search?.title ? 0.35 : 0.2;
  if (best.score < minScore) return null;
  return best;
}

function normalizeLyrics(raw: unknown): string | null {
  if (!raw) return null;
  const text = String(raw).replace(/\r\n/g, '\n').trim();
  return text || null;
}

function truncateLyrics(text: string, maxChars = 3900): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

async function fromLrcLib(query: string, artist: string, title: string): Promise<LyricsLookupResult | null> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (artist) params.set('artist_name', artist);
  if (title) params.set('track_name', title);

  const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
    signal: AbortSignal.timeout(7_000),
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null) as unknown[] | null;
  if (!Array.isArray(data) || !data.length) return null;

  const best = pickBestLyricsCandidate(data, { query, artist, title });
  if (!best) return null;

  return {
    source: 'lrclib.net',
    lyrics: best.lyrics,
  };
}

async function fromLyricsOvh(artist: string, title: string): Promise<LyricsLookupResult | null> {
  if (!artist || !title) return null;

  const encodedArtist = encodeURIComponent(artist);
  const encodedTitle = encodeURIComponent(title);
  const res = await fetch(`https://api.lyrics.ovh/v1/${encodedArtist}/${encodedTitle}`, {
    signal: AbortSignal.timeout(7_000),
  });

  if (!res.ok) return null;

  const data = await res.json().catch(() => null) as { lyrics?: string } | null;
  const lyrics = normalizeLyrics(data?.lyrics);
  if (!lyrics) return null;

  return {
    source: 'lyrics.ovh',
    lyrics,
  };
}

import type { LoggerLike } from '../../types/core.ts';

type LyricsLookupResult = {
  source: string;
  lyrics: string;
};

export class LyricsService {
  logger: LoggerLike | undefined;

  constructor(logger?: LoggerLike) {
    this.logger = logger;
  }

  async search(query: string): Promise<LyricsLookupResult | null> {
    const clean = String(query ?? '').trim();
    if (!clean) return null;

    const { artist, title } = splitArtistTitle(clean);

    try {
      const fromLrc = await fromLrcLib(clean, artist, title);
      if (fromLrc) {
        return {
          ...fromLrc,
          lyrics: truncateLyrics(fromLrc.lyrics),
        };
      }
    } catch (err) {
      this.logger?.debug?.('Lyrics provider failed', {
        provider: 'lrclib.net',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const fromOvh = await fromLyricsOvh(artist, title);
      if (fromOvh) {
        return {
          ...fromOvh,
          lyrics: truncateLyrics(fromOvh.lyrics),
        };
      }
    } catch (err) {
      this.logger?.debug?.('Lyrics provider failed', {
        provider: 'lyrics.ovh',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }
}




