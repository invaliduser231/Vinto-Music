import type { Session, Track } from '../types/domain.ts';

const MAX_ENQUEUE_QUERY_LENGTH = 500;

type LoopMode = 'off' | 'track' | 'queue';

type PlayerControl = Session['player'] & {
  pause?: () => boolean;
  resume?: () => boolean;
  skip?: () => boolean;
  playing?: boolean;
  seekTo?: (seconds: number) => number;
  setVolumePercent?: (value: number) => number;
  removeFromQueue?: (index: number) => Track | null;
  moveQueueItem?: (fromIndex: number, toIndex: number) => boolean;
  shuffleQueue?: () => number;
  setLoopMode?: (mode: string) => string;
  queuePreviousTrack?: () => Track | null;
  play?: () => Promise<void>;
  enqueue?: (query: string, options?: {
    requestedBy?: string | null;
    playNext?: boolean;
    dedupe?: boolean;
  }) => Promise<Track[]>;
  clearQueue?: () => number;
  replayCurrentTrack?: () => boolean;
  setFilterPreset?: (name: string) => string;
  setEqPreset?: (name: string) => string;
  setTempoRatio?: (value: number) => number;
  setPitchSemitones?: (value: number) => number;
};

export type DashboardAction =
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'voteSkip' }
  | { type: 'search'; query: string }
  | { type: 'favoriteCurrent' }
  | { type: 'autoplay'; enabled: boolean }
  | { type: 'saveTemplate'; name: string }
  | { type: 'libraryPlay'; kind: 'playlist' | 'template' | 'favorite' | 'station'; key: string }
  | { type: 'handoff'; userId: string | null; minutes: number }
  | { type: 'lastFm'; operation: 'connect' | 'complete' | 'disconnect' | 'toggle' | 'love' | 'unlove'; enabled?: boolean }
  | { type: 'party'; operation: 'start' | 'join' | 'vote' | 'end'; team?: 'a' | 'b' }
  | { type: 'favoriteRename'; index: number; alias: string }
  | { type: 'favoriteRemove'; index: number }
  | { type: 'playlistCreate'; name: string }
  | { type: 'playlistDelete'; name: string }
  | { type: 'playlistAddCurrent'; name: string }
  | { type: 'templateDelete'; key: string }
  | { type: 'stationCreate'; name: string; url: string }
  | { type: 'stationDelete'; key: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'skip' }
  | { type: 'shuffle' }
  | { type: 'loop'; mode: LoopMode }
  | { type: 'previous' }
  | { type: 'volume'; volumePercent: number }
  | { type: 'seek'; positionSec: number }
  | { type: 'remove'; queueIndex: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'playQueueIndex'; queueIndex: number }
  | { type: 'playHistory'; query: string; requestedBy: string }
  | { type: 'clear' }
  | { type: 'replay' }
  | { type: 'effects'; filterPreset: string; eqPreset: string; tempoRatio: number; pitchSemitones: number }
  | { type: 'enqueue'; query: string; playNext: boolean; requestedBy: string };

export type DashboardActionResult = {
  ok: boolean;
  added?: number;
};

export function parseEnqueueQuery(value: unknown): string | null {
  const query = String(value ?? '').trim();
  if (!query) return null;
  if (query.length > MAX_ENQUEUE_QUERY_LENGTH) return null;
  return query;
}

export function parseLoopMode(value: unknown): LoopMode | null {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'off' || mode === 'track' || mode === 'queue') return mode;
  return null;
}

function buildEnqueueQuery(track: Track): string | null {
  const url = String(track.url ?? '').trim();
  if (url) return url;
  const title = String(track.title ?? '').trim();
  const artist = String(track.artist ?? '').trim();
  const query = `${title} ${artist}`.trim();
  return query || null;
}

export function executeDashboardAction(session: Session, action: DashboardAction): boolean {
  const player = session.player as PlayerControl;

  switch (action.type) {
    case 'pause':
      return Boolean(player.pause?.());
    case 'resume':
      return Boolean(player.resume?.());
    case 'skip':
      return Boolean(player.skip?.());
    case 'shuffle':
      if (typeof player.shuffleQueue !== 'function') return false;
      player.shuffleQueue();
      return true;
    case 'loop':
      if (typeof player.setLoopMode !== 'function') return false;
      try {
        player.setLoopMode(action.mode);
        return true;
      } catch {
        return false;
      }
    case 'volume':
      if (typeof player.setVolumePercent !== 'function') return false;
      player.setVolumePercent(action.volumePercent);
      return true;
    case 'seek':
      if (typeof player.seekTo !== 'function') return false;
      try {
        player.seekTo(action.positionSec);
        return true;
      } catch {
        return false;
      }
    case 'remove':
      return Boolean(player.removeFromQueue?.(action.queueIndex));
    case 'reorder':
      return Boolean(player.moveQueueItem?.(action.fromIndex, action.toIndex));
    case 'clear':
      if (typeof player.clearQueue !== 'function') return false;
      player.clearQueue();
      return true;
    case 'replay':
      return Boolean(player.replayCurrentTrack?.());
    case 'effects':
      if (
        typeof player.setFilterPreset !== 'function'
        || typeof player.setEqPreset !== 'function'
        || typeof player.setTempoRatio !== 'function'
        || typeof player.setPitchSemitones !== 'function'
      ) {
        return false;
      }
      try {
        player.setFilterPreset(action.filterPreset);
        player.setEqPreset(action.eqPreset);
        player.setTempoRatio(action.tempoRatio);
        player.setPitchSemitones(action.pitchSemitones);
        return true;
      } catch {
        return false;
      }
    case 'previous':
    case 'playQueueIndex':
    case 'enqueue':
    case 'join':
    case 'leave':
    case 'voteSkip':
    case 'search':
    case 'favoriteCurrent':
    case 'autoplay':
    case 'saveTemplate':
    case 'libraryPlay':
    case 'handoff':
    case 'lastFm':
    case 'party':
    case 'playHistory':
    case 'favoriteRename':
    case 'favoriteRemove':
    case 'playlistCreate':
    case 'playlistDelete':
    case 'playlistAddCurrent':
    case 'templateDelete':
    case 'stationCreate':
    case 'stationDelete':
      return false;
    default:
      return false;
  }
}

export async function runDashboardAction(
  session: Session,
  action: DashboardAction,
): Promise<DashboardActionResult> {
  if (action.type === 'previous') {
    const player = session.player as PlayerControl;
    if (typeof player.queuePreviousTrack !== 'function') return { ok: false };
    const previous = player.queuePreviousTrack();
    if (!previous) return { ok: false };
    if (player.playing) {
      return { ok: Boolean(player.skip?.()) };
    }
    if (typeof player.play !== 'function') return { ok: false };
    try {
      await player.play();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  if (action.type === 'playQueueIndex') {
    const player = session.player as PlayerControl;
    const removed = player.removeFromQueue?.(action.queueIndex);
    if (!removed) return { ok: false };

    const query = buildEnqueueQuery(removed);
    if (!query || typeof player.enqueue !== 'function') return { ok: false };

    const added = await player.enqueue(query, {
      requestedBy: removed.requestedBy ?? null,
      playNext: true,
      dedupe: false,
    });
    if (!added.length) return { ok: false };

    if (player.playing) {
      return { ok: Boolean(player.skip?.()) };
    }
    if (typeof player.play !== 'function') return { ok: false };
    try {
      await player.play();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  if (action.type === 'playHistory') {
    const player = session.player as PlayerControl;
    if (typeof player.enqueue !== 'function') return { ok: false };
    const query = parseEnqueueQuery(action.query);
    if (!query) return { ok: false };
    const added = await player.enqueue(query, {
      requestedBy: action.requestedBy,
      playNext: true,
      dedupe: false,
    });
    if (!added.length) return { ok: false };
    if (player.playing) return { ok: Boolean(player.skip?.()), added: added.length };
    if (typeof player.play !== 'function') return { ok: false };
    try {
      await player.play();
      return { ok: true, added: added.length };
    } catch {
      return { ok: false };
    }
  }

  if (action.type === 'enqueue') {
    const player = session.player as PlayerControl;
    if (typeof player.enqueue !== 'function') return { ok: false };

    const query = parseEnqueueQuery(action.query);
    if (!query) return { ok: false };

    const added = await player.enqueue(query, {
      requestedBy: action.requestedBy,
      playNext: action.playNext,
      dedupe: Boolean(session.settings?.dedupeEnabled),
    });
    if (added.length > 0 && !player.playing && !player.currentTrack && typeof player.play === 'function') {
      try {
        await player.play();
      } catch {
        return { ok: false };
      }
    }
    return { ok: added.length > 0, added: added.length };
  }

  return { ok: executeDashboardAction(session, action) };
}
