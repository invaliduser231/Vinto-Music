'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';
import type { GuildSettings } from '@/types/guild-settings';

export function useGuildSettings(
  connect: DevConnectSettings,
  guildId: string,
  enabled: boolean,
) {
  const [settings, setSettings] = useState<GuildSettings | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const id = guildId.trim();
    const userId = connect.userId.trim();
    const secret = connect.secret.trim();
    if (!id || !userId || !secret) {
      setSettings(null);
      return;
    }

    setLoading(true);
    try {
      const url = new URL('/api/v1/guild/settings', connect.apiUrl);
      url.searchParams.set('guildId', id);
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${secret}`,
          'X-User-Id': userId,
        },
      });
      if (!response.ok) {
        setSettings(null);
        return;
      }
      const payload = await response.json() as { settings?: GuildSettings };
      setSettings(payload.settings ?? null);
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [connect.apiUrl, connect.secret, connect.userId, guildId]);

  useEffect(() => {
    if (!enabled) {
      setSettings(null);
      return;
    }
    void load();
  }, [enabled, load]);

  const patch = useCallback(async (patchBody: Partial<GuildSettings>) => {
    const id = guildId.trim();
    const userId = connect.userId.trim();
    const secret = connect.secret.trim();
    if (!id || !userId || !secret) return false;

    try {
      const url = new URL('/api/v1/guild/settings', connect.apiUrl);
      url.searchParams.set('guildId', id);
      const response = await fetch(url.toString(), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'X-User-Id': userId,
        },
        body: JSON.stringify({ patch: patchBody }),
      });
      if (!response.ok) return false;
      const payload = await response.json() as { settings?: GuildSettings };
      if (payload.settings) setSettings(payload.settings);
      return true;
    } catch {
      return false;
    }
  }, [connect.apiUrl, connect.secret, connect.userId, guildId]);

  return { settings, loading, patch, reload: load };
}
