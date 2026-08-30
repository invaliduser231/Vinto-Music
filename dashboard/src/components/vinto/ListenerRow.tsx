'use client';

import { memo, useState } from 'react';
import { getDefaultUserAvatarUrl } from '@/lib/fluxer-cdn';
import type { SessionListener } from '@/types/session';

const MAX_VISIBLE = 6;

function ListenerAvatar({ listener }: { listener: SessionListener }) {
  const [failed, setFailed] = useState(false);
  const label = listener.name ?? 'Listener';
  const src = listener.avatarUrl || getDefaultUserAvatarUrl(listener.id);

  if (failed) {
    return (
      <div className="vinto-listener-avatar" title={label} aria-label={label}>
        {label.slice(0, 1).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      className="vinto-listener-avatar"
      src={src}
      alt={label}
      title={label}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export const ListenerRow = memo(function ListenerRow({ listeners }: { listeners: SessionListener[] }) {
  if (!listeners.length) return null;

  const visible = listeners.slice(0, MAX_VISIBLE);
  const overflow = listeners.length - visible.length;
  const names = listeners.map((listener) => listener.name ?? 'Listener').join(', ');

  return (
    <div
      className="vinto-listener-row"
      aria-label={`${listeners.length} listening: ${names}`}
      title={names}
    >
      <div className="vinto-listener-stack">
        {visible.map((listener) => (
          <ListenerAvatar key={listener.id} listener={listener} />
        ))}
        {overflow > 0 ? <div className="vinto-listener-avatar more">+{overflow}</div> : null}
      </div>
      <span>{listeners.length} listening</span>
    </div>
  );
});
