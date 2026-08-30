'use client';

import { useEffect, useState } from 'react';
import type { OAuthGuild } from '@/lib/fluxer-oauth';

export type { OAuthGuild };

export function useOAuthGuilds(enabled: boolean, loggedIn: boolean) {
  const [guilds, setGuilds] = useState<OAuthGuild[]>([]);

  useEffect(() => {
    if (!enabled || !loggedIn) {
      setGuilds([]);
      return undefined;
    }

    const controller = new AbortController();
    void fetch('/api/fluxer/guilds', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = await response.json() as { guilds?: OAuthGuild[] };
        return Array.isArray(payload.guilds) ? payload.guilds : [];
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        setGuilds(next);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setGuilds([]);
      });

    return () => controller.abort();
  }, [enabled, loggedIn]);

  return guilds;
}
