'use client';

import { useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';

export function useBotGuildIds(
  settings: DevConnectSettings,
  oauthGuildIds: string[],
  enabled: boolean,
) {
  const [guildIds, setGuildIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setGuildIds([]);
      setLoaded(false);
      return undefined;
    }

    const secret = settings.secret.trim();
    if (!secret || oauthGuildIds.length === 0) {
      setGuildIds([]);
      setLoaded(true);
      return undefined;
    }

    setLoaded(false);
    const url = new URL('/api/v1/bot/guilds', settings.apiUrl);
    url.searchParams.set('guildIds', oauthGuildIds.join(','));

    const controller = new AbortController();
    void fetch(url.toString(), {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = await response.json() as { guildIds?: string[] };
        if (!Array.isArray(payload.guildIds)) return [];
        return payload.guildIds.map((entry) => String(entry).trim()).filter(Boolean);
      })
      .then((ids) => {
        if (controller.signal.aborted) return;
        const oauthSet = new Set(oauthGuildIds);
        setGuildIds(ids.filter((id) => oauthSet.has(id)));
        setLoaded(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setGuildIds([]);
        setLoaded(true);
      });

    return () => controller.abort();
  }, [enabled, settings.apiUrl, settings.secret, oauthGuildIds]);

  return { guildIds, loaded };
}
