import { ValidationError } from '../../core/errors.ts';

export const DEFAULT_PAGE_SIZE = 10;
type GuildStatsRow = {
  guildId: string;
  plays: number;
  skips: number;
  favorites: number;
  score: number;
};

type TasteRow = {
  term: string;
  count: number;
};

type UserProfileLike = Record<string, unknown> & {
  guildStats?: unknown;
  taste?: unknown;
};

export function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeGuildId(guildId: unknown): string {
  const value = String(guildId ?? '').trim();
  if (!/^\d{6,}$/.test(value)) {
    throw new ValidationError('A valid guild id is required.');
  }
  return value;
}

export function normalizeUserId(userId: unknown): string {
  const value = String(userId ?? '').trim();
  if (!/^\d{6,}$/.test(value)) {
    throw new ValidationError('A valid user id is required.');
  }
  return value;
}

export function normalizeChannelId(channelId: unknown, label = 'channel id'): string {
  const value = String(channelId ?? '').trim();
  if (!/^\d{6,}$/.test(value)) {
    throw new ValidationError(`A valid ${label} is required.`);
  }
  return value;
}

export function normalizePlaylistName(name: unknown): string {
  const value = String(name ?? '').trim();
  if (!value) {
    throw new ValidationError('Playlist name is required.');
  }
  if (value.length > 80) {
    throw new ValidationError('Playlist name must be at most 80 characters.');
  }
  return value;
}

export function normalizePlaylistNameKey(name: unknown): string {
  return normalizePlaylistName(name).toLowerCase();
}

export function normalizeTrack(track: Record<string, unknown> | null | undefined, fallbackRequester: string | null = null) {
  const title = String(track?.title ?? '').trim() || 'Unknown title';
  const url = String(track?.url ?? '').trim();
  const duration = String(track?.duration ?? 'Unknown').trim() || 'Unknown';
  const source = String(track?.source ?? 'unknown').trim() || 'unknown';
  const thumbnailUrlRaw = String(track?.thumbnailUrl ?? track?.thumbnail_url ?? track?.thumbnail ?? '').trim();
  const requestedBy = track?.requestedBy != null
    ? String(track.requestedBy)
    : (fallbackRequester ? String(fallbackRequester) : null);

  if (!url) {
    throw new ValidationError('Track is missing URL.');
  }

  const playedAt = track?.playedAt instanceof Date
    ? track.playedAt
    : (typeof track?.playedAt === 'string' ? track.playedAt : null);

  return {
    title: title.slice(0, 256),
    url: url.slice(0, 1024),
    duration: duration.slice(0, 32),
    source: source.slice(0, 64),
    thumbnailUrl: /^https?:\/\//i.test(thumbnailUrlRaw) ? thumbnailUrlRaw.slice(0, 2048) : null,
    requestedBy: requestedBy ? requestedBy.slice(0, 64) : null,
    artist: track?.artist != null ? String(track.artist).slice(0, 256) : null,
    playedAt,
    savedAt: new Date(),
  };
}

export function paginateList<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);

  return {
    items: slice,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export function toTimestamp(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

export function sanitizeFeaturePatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.startsWith('$') || key.includes('.')) continue;
    next[key] = entry;
  }
  return next;
}

export function defaultGuildFeatureConfig(guildId: string) {
  return {
    guildId,
    recapChannelId: null,
    webhookUrl: null,
    sessionPanelChannelId: null,
    sessionPanelMessageId: null,
    persistentVoiceConnections: [],
    restartRecoveryConnections: [],
    persistentVoiceChannelId: null,
    persistentTextChannelId: null,
    persistentVoiceUpdatedAt: null,
    queueTemplates: [],
    voiceProfiles: [],
    queueGuard: {
      enabled: false,
      maxPerRequesterWindow: 5,
      windowSize: 25,
      maxArtistStreak: 3,
    },
    updatedAt: null,
    createdAt: null,
  };
}

export function tokensFromTrack(track: Record<string, unknown> | null | undefined) {
  const title = String(track?.title ?? '').toLowerCase();
  const artist = String(track?.artist ?? track?.requestedByArtist ?? '').toLowerCase();
  const words = `${title} ${artist}`
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !['official', 'video', 'lyrics', 'audio', 'feat'].includes(word));
  return words.slice(0, 8);
}

export function applyUserProfileSignal(
  profile: UserProfileLike | null | undefined,
  guildId: unknown,
  signal: unknown,
  track: Record<string, unknown> | null = null
) {
  const safeGuildId = normalizeGuildId(guildId);
  const safeSignal = String(signal ?? '').toLowerCase();
  const next: UserProfileLike = profile && typeof profile === 'object' ? { ...profile } : {};
  const now = new Date();

  const guildStats: GuildStatsRow[] = Array.isArray(next.guildStats)
    ? next.guildStats
      .filter((entry): entry is GuildStatsRow => {
        return Boolean(
          entry
            && typeof entry === 'object'
            && typeof (entry as GuildStatsRow).guildId === 'string'
            && typeof (entry as GuildStatsRow).plays === 'number'
            && typeof (entry as GuildStatsRow).skips === 'number'
            && typeof (entry as GuildStatsRow).favorites === 'number'
            && typeof (entry as GuildStatsRow).score === 'number'
        );
      })
      .map((entry) => ({ ...entry }))
    : [];
  let stats = guildStats.find((entry) => entry.guildId === safeGuildId);
  if (!stats) {
    stats = { guildId: safeGuildId, plays: 0, skips: 0, favorites: 0, score: 0 };
    guildStats.push(stats);
  }

  if (safeSignal === 'play') {
    stats.plays += 1;
    stats.score += 1;
  } else if (safeSignal === 'skip') {
    stats.skips += 1;
    stats.score -= 1;
  } else if (safeSignal === 'favorite') {
    stats.favorites += 1;
    stats.score += 2;
  }

  const tokens = tokensFromTrack(track);
  const taste: TasteRow[] = Array.isArray(next.taste)
    ? next.taste
      .filter((entry): entry is TasteRow => {
        return Boolean(
          entry
            && typeof entry === 'object'
            && typeof (entry as TasteRow).term === 'string'
            && typeof (entry as TasteRow).count === 'number'
        );
      })
      .map((entry) => ({ ...entry }))
    : [];
  for (const token of tokens) {
    const row = taste.find((entry) => entry.term === token);
    if (row) {
      row.count += 1;
    } else {
      taste.push({ term: token, count: 1 });
    }
  }
  taste.sort((a, b) => b.count - a.count);

  return {
    ...next,
    guildStats,
    taste: taste.slice(0, 80),
    updatedAt: now,
  };
}
