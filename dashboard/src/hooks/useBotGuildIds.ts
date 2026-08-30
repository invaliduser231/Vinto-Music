'use client';

import { useEffect, useState } from 'react';
import { botApiPath } from '@/lib/bot-client';

export function useBotGuildIds(
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

    if (oauthGuildIds.length === 0) {
      setGuildIds([]);
      setLoaded(true);
      return undefined;
    }

    setLoaded(false);
    const controller = new AbortController();
    void fetch(botApiPath('bot/guilds', { guildIds: oauthGuildIds.join(',') }), {
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
  }, [enabled, oauthGuildIds]);

  return { guildIds, loaded };
}
