import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH_SESSION_COOKIE = 'vinto_dashboard_session';
export const OAUTH_STATE_COOKIE = 'vinto_oauth_state';

export type AuthSession = {
  userId: string;
  username: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

function digestEqual(expected: string, actual: string): boolean {
  const expectedBuffer = createHash('sha256').update(expected).digest();
  const actualBuffer = createHash('sha256').update(actual).digest();
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function sealValue(payload: string, secret: string): string {
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function openValue<T>(value: string, secret: string): T | null {
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!digestEqual(expected, sig)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function sealAuthSession(session: AuthSession, secret: string): string {
  return sealValue(JSON.stringify(session), secret);
}

export function openAuthSession(value: string, secret: string): AuthSession | null {
  return openValue<AuthSession>(value, secret);
}

export function createOAuthState(): string {
  return randomBytes(24).toString('base64url');
}
