'use client';

import { memo } from 'react';
import { formatTime } from '@/lib/format-time';
import { usePlaybackProgress, type PlaybackProgressStore } from '@/lib/playback-progress';

export const PlaybackProgressRow = memo(function PlaybackProgressRow({
  store,
  canControl,
  onSeek,
}: {
  store: PlaybackProgressStore;
  canControl: boolean;
  onSeek: (positionSec: number) => void;
}) {
  const { positionSec, durationSec, seekable } = usePlaybackProgress(store);
  const interactive = canControl && seekable;
  const percent = durationSec > 0
    ? Math.max(0, Math.min(100, (positionSec / durationSec) * 100))
    : 0;

  return (
    <div className="vinto-progress-row">
      <span>{formatTime(positionSec)}</span>
      <div
        className={`vinto-progress-bar${interactive ? '' : ' read-only'}`}
        onClick={(event) => {
          if (!interactive) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          onSeek(ratio * durationSec);
        }}
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(positionSec)}
        aria-valuetext={`${formatTime(positionSec)} of ${formatTime(durationSec)}`}
        onKeyDown={(event) => {
          if (!interactive) return;
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, positionSec - 5));
          if (event.key === 'ArrowRight') onSeek(Math.min(durationSec, positionSec + 5));
        }}
      >
        <div className="vinto-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span>{formatTime(durationSec)}</span>
    </div>
  );
});
