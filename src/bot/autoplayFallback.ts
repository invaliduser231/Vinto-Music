import { normalizeMirrorText } from '../player/musicPlayer/mirrorMatch.ts';
import { extractYouTubeVideoId } from '../player/musicPlayer/trackUtils.ts';
import { parseDurationToSeconds } from './commands/helpers/formatting.ts';

export const AUTOPLAY_MIN_DURATION_SEC = 45;
export const AUTOPLAY_MAX_DURATION_SEC = 15 * 60;
const MIX_CANDIDATE_LIMIT = 25;
const ARTIST_CANDIDATE_LIMIT = 10;
const PICK_POOL_SIZE = 8;

export type AutoplayTrackLike = {
  title?: unknown;
  url?: unknown;
  artist?: unknown;
  duration?: unknown;
  isLive?: unknown;
};

export type AutoplayFallbackPlayer = {
  previewTracks?: (query: string, options: { requestedBy?: string | null; limit?: number }) => Promise<unknown[]>;
  searchCandidates?: (query: string, limit?: number, options?: { requestedBy?: string | null }) => Promise<unknown[]>;
};

export type AutoplayFallbackResult = {
  track: unknown;
  strategy: 'youtube-mix' | 'same-artist';
};

function titleKey(track: AutoplayTrackLike | null | undefined): string {
  const title = normalizeMirrorText(String(track?.title ?? ''))
    .replace(/\b(official|video|audio|lyrics?|music|hd|4k|remaster(ed)?|visualizer|mv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title;
}

function urlKey(track: AutoplayTrackLike | null | undefined): string {
  const url = String(track?.url ?? '').trim();
  const videoId = extractYouTubeVideoId(url);
  return videoId ? `yt:${videoId}` : url.toLowerCase();
}

function buildRecentKeys(tracks: Array<AutoplayTrackLike | null | undefined>): Set<string> {
  const keys = new Set<string>();
  for (const track of tracks) {
    if (!track) continue;
    const title = titleKey(track);
    const url = urlKey(track);
    if (title) keys.add(`t:${title}`);
    if (url) keys.add(`u:${url}`);
  }
  return keys;
}

export function isAutoplayCandidate(track: AutoplayTrackLike | null | undefined, recent: Set<string>): boolean {
  if (!track || track.isLive === true) return false;
  const title = titleKey(track);
  const url = urlKey(track);
  if (!title && !url) return false;
  if (title && recent.has(`t:${title}`)) return false;
  if (url && recent.has(`u:${url}`)) return false;

  const seconds = typeof track.duration === 'number' ? track.duration : parseDurationToSeconds(track.duration);
  if (seconds != null && seconds > 0) {
    if (seconds < AUTOPLAY_MIN_DURATION_SEC || seconds > AUTOPLAY_MAX_DURATION_SEC) return false;
  }
  return true;
}

function pickFrom(candidates: unknown[], recent: Set<string>, random: () => number): unknown | null {
  const pool = candidates
    .filter((candidate) => isAutoplayCandidate(candidate as AutoplayTrackLike, recent))
    .slice(0, PICK_POOL_SIZE);
  if (!pool.length) return null;
  return pool[Math.floor(random() * pool.length)] ?? pool[0] ?? null;
}

function primaryArtist(value: unknown): string {
  return String(value ?? '').split(/[,;&/]| x | feat\.? | ft\.? /i)[0]?.trim() ?? '';
}

export async function findFallbackAutoplayTrack(
  player: AutoplayFallbackPlayer,
  previous: AutoplayTrackLike | null | undefined,
  history: Array<AutoplayTrackLike | null | undefined>,
  random: () => number = Math.random,
): Promise<AutoplayFallbackResult | null> {
  if (!previous) return null;
  const recent = buildRecentKeys([previous, ...history]);

  const videoId = extractYouTubeVideoId(String(previous.url ?? ''));
  if (videoId && player.previewTracks) {
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    const mix = await player.previewTracks(mixUrl, { requestedBy: null, limit: MIX_CANDIDATE_LIMIT }).catch(() => []);
    const picked = pickFrom(Array.isArray(mix) ? mix : [], recent, random);
    if (picked) return { track: picked, strategy: 'youtube-mix' };
  }

  const artist = primaryArtist(previous.artist);
  if (artist && player.searchCandidates) {
    const found = await player.searchCandidates(artist, ARTIST_CANDIDATE_LIMIT, { requestedBy: null }).catch(() => []);
    const picked = pickFrom(Array.isArray(found) ? found : [], recent, random);
    if (picked) return { track: picked, strategy: 'same-artist' };
  }

  return null;
}
