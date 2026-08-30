'use client';

export function botApiPath(
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `/api/bot/${path}?${query}` : `/api/bot/${path}`;
}

export type BotTicket = {
  ticket: string;
  userId: string;
};

export async function requestBotTicket(): Promise<BotTicket | null> {
  try {
    const response = await fetch('/api/bot/ticket', { method: 'POST' });
    if (!response.ok) return null;
    const payload = await response.json() as { ticket?: unknown; userId?: unknown };
    const ticket = String(payload.ticket ?? '').trim();
    const userId = String(payload.userId ?? '').trim();
    if (!ticket || !userId) return null;
    return { ticket, userId };
  } catch {
    return null;
  }
}

export function resolveWebSocketUrl(): string {
  const configured = String(process.env.NEXT_PUBLIC_DASHBOARD_WS_URL ?? '').trim();
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
