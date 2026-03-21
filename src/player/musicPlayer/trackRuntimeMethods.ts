import { buildTrackId } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

type TrackRuntimeMethods = {
  _cloneTrack(track: Track | null | undefined, overrides?: Partial<Track> & { id?: string; queuedAt?: number }): Track;
  _trackKey(track: Partial<Track> | null | undefined): string | null;
  _hasDuplicateTrack(candidate: Track | null | undefined): boolean;
  _rememberTrack(track: Track | null | undefined): void;
  _parseDurationSeconds(value: unknown): number | null;
};
type TrackRuntime = MusicPlayer & TrackRuntimeMethods;

export const trackRuntimeMethods: TrackRuntimeMethods & ThisType<TrackRuntime> = {
  _cloneTrack(track: Track | null | undefined, overrides: { id?: string; queuedAt?: number; [key: string]: unknown } = {}) {
    const next = {
      ...track,
      ...overrides,
    } as Track;
    next.id = overrides.id ?? buildTrackId();
    next.queuedAt = overrides.queuedAt ?? Date.now();
    return next;
  },

  _trackKey(track: Partial<Track> | null | undefined) {
    if (!track) return null;
    const url = String(track.url ?? '').trim().toLowerCase();
    if (url) return `url:${url}`;
    const title = String(track.title ?? '').trim().toLowerCase();
    return title ? `title:${title}` : null;
  },

  _hasDuplicateTrack(candidate: Track | null | undefined) {
    const key = this._trackKey(candidate);
    if (!key) return false;

    if (this._trackKey(this.currentTrack) === key) return true;
    return this.pendingTracks.some((track: Track) => this._trackKey(track) === key);
  },

  _rememberTrack(track: Track | null | undefined) {
    if (!track) return;

    const snapshot = this._cloneTrack(track, {
      seekStartSec: 0,
      ...(track.id ? { id: track.id } : {}),
      ...(typeof track.queuedAt === 'number' ? { queuedAt: track.queuedAt } : {}),
    });
    this.trackHistory.push(snapshot);

    if (this.trackHistory.length > this.maxHistorySize) {
      this.trackHistory.splice(0, this.trackHistory.length - this.maxHistorySize);
    }
  },

  _parseDurationSeconds(value: unknown) {
    if (!value || typeof value !== 'string') return null;
    if (value.toLowerCase() === 'unknown') return null;

    const parts = value.split(':').map((part) => Number.parseInt(part, 10));
    if (!parts.every((part) => Number.isFinite(part))) return null;

    if (parts.length === 2) {
      return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    }
    if (parts.length === 3) {
      return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
    }

    return null;
  },
};
