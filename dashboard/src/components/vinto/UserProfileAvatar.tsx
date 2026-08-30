'use client';

import { useState } from 'react';
import { getDefaultUserAvatarUrl } from '@/lib/fluxer-cdn';
import type { AuthUser } from '@/hooks/useAuthSession';

export function UserProfileAvatar({ user, size }: { user: AuthUser; size?: number }) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = user.avatarUrl || getDefaultUserAvatarUrl(user.id);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined;

  if (!failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="vinto-avatar"
        style={style}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="vinto-avatar" style={style}>{user.username.slice(0, 1).toUpperCase()}</div>
  );
}
