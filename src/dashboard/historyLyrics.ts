import type { MusicLibraryStore } from '../bot/services/musicLibraryStore.ts';
import type { Session, Track } from '../types/domain.ts';
import {
  type DashboardTrackPayload,
  serializeTrack,
} from './sessionSnapshot.ts';

export const DASHBOARD_HISTORY_PAGE_SIZE = 25;

export type DashboardHistoryPayload = {
  items: DashboardTrackPayload[];
  page: number;
  totalPages: number;
  total: number;
};

export type DashboardLyricsPayload = {
  query: string;
  source: string;
  lyrics: string;
};

function storedTrackAsTrack(track: Record<string, unknown>, index: number): Track {
  return {
    title: String(track.title ?? 'Unknown title'),
    url: String(track.url ?? ''),
    duration: String(track.duration ?? ''),
    source: String(track.source ?? 'unknown'),
    thumbnailUrl: track.thumbnailUrl == null ? null : String(track.thumbnailUrl),
    artist: track.artist == null ? null : String(track.artist),
    requestedBy: track.requestedBy == null ? null : String(track.requestedBy),
    id: String(track.id ?? `history-${index}`),
  };
}

export async function buildGuildHistoryPayload(options: {
  guildId: string;
  page: number;
  session: Session | null;
  library: MusicLibraryStore | null;
}): Promise<DashboardHistoryPayload> {
  const page = Math.max(1, Number.parseInt(String(options.page ?? 1), 10) || 1);
  const player = options.session?.player as (Session['player'] & { historyTracks?: Track[] }) | undefined;
  const historyTracks = player?.historyTracks ?? [];

  if (historyTracks.length) {
    const newestFirst = [...historyTracks].reverse();
    const total = newestFirst.length;
    const totalPages = Math.max(1, Math.ceil(total / DASHBOARD_HISTORY_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * DASHBOARD_HISTORY_PAGE_SIZE;
    const slice = newestFirst.slice(start, start + DASHBOARD_HISTORY_PAGE_SIZE);
    return {
      items: slice.map((track, index) => serializeTrack(track, start + index)),
      page: safePage,
      totalPages,
      total,
    };
  }

  if (!options.library) {
    return { items: [], page: 1, totalPages: 1, total: 0 };
  }

  const persisted = await options.library.listGuildHistory(
    options.guildId,
    page,
    DASHBOARD_HISTORY_PAGE_SIZE,
  );
  const items = persisted.items.map((track, index) => (
    serializeTrack(storedTrackAsTrack(track as Record<string, unknown>, index), index)
  ));

  return {
    items,
    page: persisted.page,
    totalPages: persisted.totalPages,
    total: persisted.total,
  };
}

export function buildLyricsSearchQuery(
  session: Session | null,
  explicitQuery: string,
): string | null {
  const query = String(explicitQuery ?? '').trim();
  if (query) return query;

  const currentTrack = session?.player?.currentTrack as Track | null | undefined;
  if (!currentTrack) return null;

  const title = String(currentTrack.title ?? '').trim();
  const artist = String(currentTrack.artist ?? '').trim();
  if (artist && title) return `${artist} - ${title}`;
  return title || null;
}
