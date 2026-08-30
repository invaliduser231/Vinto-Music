'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevConnectSettings } from '@/lib/live-session';
import type { DashboardHubData } from '@/types/dashboard-hub';

export function useDashboardHub(connect: DevConnectSettings, enabled: boolean, refreshKey = 0) {
  const [data, setData] = useState<DashboardHubData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const guildId = connect.guildId.trim();
    const userId = connect.userId.trim();
    if (!enabled || !guildId || !userId || !connect.secret.trim()) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/v1/dashboard/hub', connect.apiUrl);
      url.searchParams.set('guildId', guildId);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${connect.secret}`,
          'X-User-Id': userId,
        },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        hub?: DashboardHubData;
        error?: string;
      } | null;
      if (!response.ok || !payload?.hub) {
        throw new Error(payload?.error ?? 'Dashboard data could not be loaded');
      }
      setData(payload.hub);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : 'Dashboard data could not be loaded');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [connect.apiUrl, connect.guildId, connect.secret, connect.userId, enabled, refreshKey]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  return { data, loading, error, reload: load };
}
