'use client';

import { useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';

export type UserVoiceBinding = {
  guildId: string;
  voiceChannelId: string;
};

export function useUserVoiceDiscovery(
  connect: DevConnectSettings,
  guildIds: string[],
  enabled: boolean,
  pollMs = 2500,
) {
  const [binding, setBinding] = useState<UserVoiceBinding | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBinding(null);
      return undefined;
    }

    const userId = connect.userId.trim();
    const secret = connect.secret.trim();
    if (!userId || !secret || guildIds.length === 0) {
      setBinding(null);
      return undefined;
    }

    const controller = new AbortController();

    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const url = new URL('/api/v1/user/voice', connect.apiUrl);
        url.searchParams.set('guildIds', guildIds.join(','));
        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${secret}`,
            'X-User-Id': userId,
          },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = await response.json() as { voice?: UserVoiceBinding | null };
        if (!controller.signal.aborted) {
          setBinding(payload.voice ?? null);
        }
      } catch {
        if (!controller.signal.aborted) setBinding(null);
      }
    };

    void load();
    const timer = setInterval(() => void load(), pollMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [connect.apiUrl, connect.secret, connect.userId, enabled, guildIds, pollMs]);

  return binding;
}
