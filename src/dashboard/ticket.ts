import { createHmac, timingSafeEqual } from 'node:crypto';

export type DashboardTicket = {
  userId: string;
  exp: number;
};

export const MAX_TICKET_LIFETIME_MS = 120_000;

export function signDashboardTicket(payload: DashboardTicket, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyDashboardTicket(
  ticket: string,
  secret: string,
  now: number = Date.now(),
): DashboardTicket | null {
  const safeSecret = String(secret ?? '');
  const raw = String(ticket ?? '').trim();
  if (!safeSecret || !raw) return null;

  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!body || !signature) return null;

  const expected = createHmac('sha256', safeSecret).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const userId = String(record.userId ?? '').trim();
  const exp = Number(record.exp);
  if (!userId || !Number.isFinite(exp)) return null;
  if (exp <= now) return null;
  if (exp - now > MAX_TICKET_LIFETIME_MS) return null;

  return { userId, exp };
}
