'use client';

import { useEffect, useState } from 'react';
import { botApiPath } from '@/lib/bot-client';

export type UserVoiceBinding = {
  guildId: string;
  voiceChannelId: string;
};

export function useUserVoiceDiscovery(
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

    if (guildIds.length === 0) {
      setBinding(null);
      return undefined;
    }

    const controller = new AbortController();

    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(botApiPath('user/voice', { guildIds: guildIds.join(',') }), {
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
  }, [enabled, guildIds, pollMs]);

  return binding;
}
