function splitArtistTitle(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return { artist: '', title: '' };

  const separators = [' - ', ' – ', ' — ', ':'];
  for (const sep of separators) {
    if (!raw.includes(sep)) continue;
    const [left, ...rest] = raw.split(sep);
    const right = rest.join(sep).trim();
    if (!left.trim() || !right) continue;
    return { artist: left.trim(), title: right };
  }

  return { artist: '', title: raw };
}

function normalizeLyrics(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\r\n/g, '\n').trim();
  return text || null;
}

function truncateLyrics(text, maxChars = 3900) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

async function fromLrcLib(query, artist, title) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (artist) params.set('artist_name', artist);
  if (title) params.set('track_name', title);

  const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
    signal: AbortSignal.timeout(7_000),
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!Array.isArray(data) || !data.length) return null;

  const first = data.find((item) => item?.plainLyrics)?.plainLyrics ?? null;
  if (!first) return null;

  const lyrics = normalizeLyrics(first);
  if (!lyrics) return null;

  return {
    source: 'lrclib.net',
    lyrics,
  };
}

async function fromLyricsOvh(artist, title) {
  if (!artist || !title) return null;

  const encodedArtist = encodeURIComponent(artist);
  const encodedTitle = encodeURIComponent(title);
  const res = await fetch(`https://api.lyrics.ovh/v1/${encodedArtist}/${encodedTitle}`, {
    signal: AbortSignal.timeout(7_000),
  });

  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  const lyrics = normalizeLyrics(data?.lyrics);
  if (!lyrics) return null;

  return {
    source: 'lyrics.ovh',
    lyrics,
  };
}

export class LyricsService {
  constructor(logger) {
    this.logger = logger;
  }

  async search(query) {
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
