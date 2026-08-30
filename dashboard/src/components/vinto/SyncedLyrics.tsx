'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import { findActiveLineIndex, parseLrc } from '@/lib/lrc';
import { usePlaybackProgress, type PlaybackProgressStore } from '@/lib/playback-progress';

export const SyncedLyrics = memo(function SyncedLyrics({
  store,
  source,
  plain,
  synced,
  canSeek,
  onSeek,
}: {
  store: PlaybackProgressStore;
  source: string;
  plain: string;
  synced: string | null;
  canSeek: boolean;
  onSeek: (positionSec: number) => void;
}) {
  const lines = useMemo(() => parseLrc(synced), [synced]);
  const { positionSec } = usePlaybackProgress(store);
  const activeIndex = lines.length ? findActiveLineIndex(lines, positionSec) : -1;
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const node = activeRef.current;
    const container = containerRef.current;
    if (!node || !container) return;
    const offset = node.offsetTop - (container.clientHeight / 2) + (node.clientHeight / 2);
    container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  }, [activeIndex]);

  if (!lines.length) {
    return (
      <div className="vinto-lyrics-panel">
        <div className="vinto-lyrics-source">
          {source}
          <span className="vinto-lyrics-badge">not timed</span>
        </div>
        <pre className="vinto-lyrics-text">{plain}</pre>
      </div>
    );
  }

  return (
    <div className="vinto-lyrics-panel synced" ref={containerRef}>
      <div className="vinto-lyrics-source">{source}</div>
      <div className="vinto-lyrics-lines">
        {lines.map((line, index) => {
          const state = index === activeIndex
            ? ' active'
            : index < activeIndex ? ' past' : '';
          const content = line.text || '·';
          if (!canSeek) {
            return (
              <p
                key={`${line.timeSec}-${index}`}
                ref={index === activeIndex ? activeRef : undefined}
                className={`vinto-lyric-line${state}`}
              >
                {content}
              </p>
            );
          }
          return (
            <p
              key={`${line.timeSec}-${index}`}
              ref={index === activeIndex ? activeRef : undefined}
              className={`vinto-lyric-line seekable${state}`}
              role="button"
              tabIndex={0}
              onClick={() => onSeek(line.timeSec)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSeek(line.timeSec);
              }}
            >
              {content}
            </p>
          );
        })}
      </div>
    </div>
  );
});
