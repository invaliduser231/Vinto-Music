'use client';

import { useCallback, useEffect, useState } from 'react';

export type AuthUser = {
  id: string;
  username: string;
  avatarUrl: string;
};

export function useAuthSession() {
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const configResponse = await fetch('/api/auth/config');
      const configPayload = await configResponse.json() as { enabled?: boolean };
      const enabled = Boolean(configPayload.enabled);
      setOauthEnabled(enabled);
      if (!enabled) {
        setUser(null);
        return;
      }
      const meResponse = await fetch('/api/auth/me');
      if (!meResponse.ok) {
        setUser(null);
        return;
      }
      const mePayload = await meResponse.json() as { user?: AuthUser | null };
      setUser(mePayload.user ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  return { oauthEnabled, user, loading, reload, logout };
}
