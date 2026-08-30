'use client';

import { useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';
import { botApiPath } from '@/lib/bot-client';
import type { VoiceChannelOption } from '@/types/session';

export type GuildOverview = {
  guildId: string;
  guildName: string;
  userVoiceChannelId: string | null;
  voiceChannels: VoiceChannelOption[];
  directory?: {
    roles: Array<{ id: string; name: string }>;
    textChannels: Array<{ id: string; name: string }>;
    voiceChannels: Array<{ id: string; name: string }>;
    members: Array<{ id: string; name: string }>;
  };
};

export function useGuildOverview(settings: DevConnectSettings, enabled: boolean) {
  const [overview, setOverview] = useState<GuildOverview | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOverview(null);
      return undefined;
    }

    const guildId = settings.guildId.trim();
    if (!guildId) {
      setOverview(null);
      return undefined;
    }

    const controller = new AbortController();
    void fetch(botApiPath('guild', { guildId }), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json() as { guild?: GuildOverview };
        return payload.guild ?? null;
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        setOverview(next);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOverview(null);
      });

    return () => controller.abort();
  }, [enabled, settings.guildId]);

  return overview;
}
