'use client';

import { useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';

export type TrackLyrics = {
  query: string;
  source: string;
  lyrics: string;
  syncedLyrics?: string | null;
};

export function useTrackLyrics(
  settings: DevConnectSettings,
  enabled: boolean,
  trackKey: string | null,
) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !trackKey) {
      setLyrics(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    const guildId = settings.guildId.trim();
    const voiceChannelId = settings.voiceChannelId.trim();
    const userId = settings.userId.trim();
    const secret = settings.secret.trim();
    if (!guildId || !voiceChannelId || !userId || !secret) {
      setLyrics(null);
      return undefined;
    }

    setLoading(true);
    setError(null);

    const url = new URL('/api/v1/track/lyrics', settings.apiUrl);
    url.searchParams.set('guildId', guildId);
    url.searchParams.set('voiceChannelId', voiceChannelId);

    const controller = new AbortController();
    void fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-User-Id': userId,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(String(payload?.error ?? `lyrics failed (${response.status})`));
        }
        const payload = await response.json() as { lyrics?: TrackLyrics };
        return payload.lyrics ?? null;
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        setLyrics(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLyrics(null);
        setError(err instanceof Error ? err.message : 'lyrics failed');
        setLoading(false);
      });

    return () => controller.abort();
  }, [
    enabled,
    settings.apiUrl,
    settings.guildId,
    settings.voiceChannelId,
    settings.userId,
    settings.secret,
    trackKey,
  ]);

  return { lyrics, loading, error };
}
