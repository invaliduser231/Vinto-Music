'use client';

import { useState } from 'react';
import { getDefaultUserAvatarUrl } from '@/lib/fluxer-cdn';

export function RequesterBadge({
  userId,
  name,
  avatarUrl,
  compact = false,
}: {
  userId: string;
  name?: string | null;
  avatarUrl?: string | null;
  compact?: boolean;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const displayName = String(name ?? '').trim() || userId;
  const resolvedAvatar = avatarUrl ?? getDefaultUserAvatarUrl(userId);

  return (
    <span className={`vinto-requester${compact ? ' compact' : ''}`}>
      {!avatarFailed ? (
        <img
          src={resolvedAvatar}
          alt=""
          className="vinto-requester-avatar-img"
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <span className="vinto-requester-avatar">{displayName.slice(0, 1).toUpperCase()}</span>
      )}
      <span className={compact ? 'vinto-requester-name' : undefined}>{displayName}</span>
    </span>
  );
}
