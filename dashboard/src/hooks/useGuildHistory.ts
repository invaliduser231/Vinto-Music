'use client';

import { useEffect, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';
import { botApiPath } from '@/lib/bot-client';
import type { QueueTrack } from '@/types/session';

export type GuildHistoryState = {
  items: QueueTrack[];
  page: number;
  totalPages: number;
  total: number;
};

const HISTORY_RETRY_ATTEMPTS = 3;
const HISTORY_RETRY_BASE_DELAY_MS = 400;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchGuildHistory(
  settings: DevConnectSettings,
  page: number,
  signal: AbortSignal,
  attempt = 1,
): Promise<GuildHistoryState | null> {
  const guildId = settings.guildId.trim();
  const voiceChannelId = settings.voiceChannelId.trim();

  const response = await fetch(
    botApiPath('guild/history', { guildId, voiceChannelId, page }),
    { signal },
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    const errorCode = String(payload?.error ?? `history failed (${response.status})`);
    if (errorCode === 'not_in_voice' && attempt < HISTORY_RETRY_ATTEMPTS) {
      await delay(HISTORY_RETRY_BASE_DELAY_MS * attempt, signal);
      return fetchGuildHistory(settings, page, signal, attempt + 1);
    }
    throw new Error(errorCode);
  }

  const payload = await response.json() as { history?: GuildHistoryState };
  return payload.history ?? null;
}

export function useGuildHistory(
  settings: DevConnectSettings,
  enabled: boolean,
  page: number,
) {
  const [history, setHistory] = useState<GuildHistoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHistory(null);
      setError(null);
      setLoading(false);
      return;
    }

    const guildId = settings.guildId.trim();
    const voiceChannelId = settings.voiceChannelId.trim();
    if (!guildId || !voiceChannelId) {
      setHistory(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void fetchGuildHistory(settings, page, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setHistory(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setHistory(null);
        setError(err instanceof Error ? err.message : 'history failed');
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    enabled,
    settings.guildId,
    settings.voiceChannelId,
    page,
  ]);

  return { history, loading, error };
}
