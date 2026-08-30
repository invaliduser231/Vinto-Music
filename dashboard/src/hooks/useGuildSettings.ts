'use client';

import { useCallback, useEffect, useState } from 'react';
import { botApiPath } from '@/lib/bot-client';
import type { GuildSettings } from '@/types/guild-settings';

export function useGuildSettings(
  guildId: string,
  enabled: boolean,
) {
  const [settings, setSettings] = useState<GuildSettings | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const id = guildId.trim();
    if (!id) {
      setSettings(null);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(botApiPath('guild/settings', { guildId: id }));
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
  }, [guildId]);

  useEffect(() => {
    if (!enabled) {
      setSettings(null);
      return;
    }
    void load();
  }, [enabled, load]);

  const patch = useCallback(async (patchBody: Partial<GuildSettings>) => {
    const id = guildId.trim();
    if (!id) return false;

    try {
      const response = await fetch(botApiPath('guild/settings', { guildId: id }), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: patchBody }),
      });
      if (!response.ok) return false;
      const payload = await response.json() as { settings?: GuildSettings };
      if (payload.settings) setSettings(payload.settings);
      return true;
    } catch {
      return false;
    }
  }, [guildId]);

  return { settings, loading, patch, reload: load };
}
