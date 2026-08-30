import { createHmac } from 'node:crypto';

export type BotApiConfig = {
  baseUrl: string;
  secret: string;
};

export const BOT_API_PROXY_BASE = '/api/bot';

export const BOT_API_ALLOWED_PATHS = new Set([
  'bot/guilds',
  'dashboard/hub',
  'guild',
  'guild/history',
  'guild/settings',
  'session',
  'session/action',
  'track/lyrics',
  'user/voice',
]);

export const TICKET_LIFETIME_MS = 60_000;

export function readBotApiConfig(): BotApiConfig | null {
  const baseUrl = String(process.env.DASHBOARD_API_URL ?? 'http://127.0.0.1:9092').trim();
  const secret = String(process.env.DASHBOARD_API_SECRET ?? '').trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export function signBotTicket(userId: string, expiresAt: number, secret: string): string {
  const body = Buffer.from(JSON.stringify({ userId, exp: expiresAt }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
