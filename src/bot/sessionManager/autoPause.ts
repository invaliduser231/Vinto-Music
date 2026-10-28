import type { Session, SessionAutoPauseReason, SessionAutoPauseState, Track } from '../../types/domain.ts';

export type AutoPauseOutcome = 'paused' | 'resumed' | null;

type AutoPauseHost = {
  _countHumanListeners(session: Session): number;
  _scheduleIdleTimeout(session: Session): void;
  _clearIdleTimer(session: Session): void;
  markSnapshotDirty(session: Session, flushSoon?: boolean): void;
};

type PausablePlayer = {
  playing?: boolean;
  paused?: boolean;
  currentTrack?: unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

function isLiveTrack(track: Partial<Track> | null | undefined): boolean {
  return track?.isLive === true || String(track?.source ?? '').startsWith('radio');
}

function ensureState(session: Session): SessionAutoPauseState {
  if (!session.autoPause) {
    session.autoPause = { reasons: new Set(), botMuted: false };
  }
  return session.autoPause;
}

export function clearAutoPause(session: { autoPause?: SessionAutoPauseState | null | undefined }): void {
  session.autoPause?.reasons.clear();
}

export function isAutoPausedForEmptyChannel(session: Session | null | undefined): boolean {
  return Boolean(session?.autoPause?.reasons.has('empty'));
}

export function evaluateAutoPause(
  host: AutoPauseHost,
  session: Session,
  botMuted: boolean | null = null,
): AutoPauseOutcome {
  const state = ensureState(session);
  if (botMuted != null) state.botMuted = botMuted;

  const player = session.player as PausablePlayer;
  const track = player.currentTrack as Partial<Track> | null | undefined;
  if (!player.playing || !track || isLiveTrack(track)) {
    state.reasons.clear();
    return null;
  }

  const wanted = new Set<SessionAutoPauseReason>();
  if (host._countHumanListeners(session) === 0) wanted.add('empty');
  if (state.botMuted) wanted.add('muted');

  if (wanted.size > 0) {
    if (state.reasons.size > 0) {
      state.reasons = wanted;
      return null;
    }
    if (player.paused || !player.pause?.()) return null;
    state.reasons = wanted;
    if (wanted.has('empty')) host._scheduleIdleTimeout(session);
    host.markSnapshotDirty(session, true);
    return 'paused';
  }

  if (state.reasons.size === 0) return null;
  state.reasons.clear();
  if (!player.paused || !player.resume?.()) return null;
  host._clearIdleTimer(session);
  host.markSnapshotDirty(session, true);
  return 'resumed';
}
