import { cookies } from 'next/headers';
import type { OAuthConfig } from './oauth-config';
import { readOAuthConfig } from './oauth-config';
import {
  AUTH_SESSION_COOKIE,
  openAuthSession,
  sealAuthSession,
  type AuthSession,
} from './auth-cookie';
import {
  exchangeAuthorizationCode,
  fetchOAuthUser,
  OAuthTokenError,
  refreshAccessToken,
} from './fluxer-oauth';

const REFRESH_SKEW_MS = 30_000;
const TRANSIENT_RETRY_DELAY_MS = 60_000;
const FAILURE_CACHE_MAX_ENTRIES = 500;

const inFlightRefreshes = new Map<string, Promise<AuthSession | null>>();
const transientFailures = new Map<string, number>();

function noteTransientFailure(refreshToken: string): void {
  if (transientFailures.size >= FAILURE_CACHE_MAX_ENTRIES) {
    const oldest = transientFailures.keys().next().value;
    if (oldest !== undefined) transientFailures.delete(oldest);
  }
  transientFailures.set(refreshToken, Date.now() + TRANSIENT_RETRY_DELAY_MS);
}

function isCoolingDown(refreshToken: string): boolean {
  const until = transientFailures.get(refreshToken);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  transientFailures.delete(refreshToken);
  return false;
}

async function persistSession(session: AuthSession, config: OAuthConfig): Promise<void> {
  try {
    const store = await cookies();
    store.set(AUTH_SESSION_COOKIE, sealAuthSession(session, config.cookieSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  } catch {
    return;
  }
}

async function clearSession(): Promise<void> {
  try {
    const store = await cookies();
    store.delete(AUTH_SESSION_COOKIE);
  } catch {
    return;
  }
}

export async function getAuthSession(): Promise<AuthSession | null> {
  const config = readOAuthConfig();
  if (!config) return null;
  const store = await cookies();
  const raw = store.get(AUTH_SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = openAuthSession(raw, config.cookieSecret);
  if (!session) return null;
  if (session.expiresAt > Date.now() + REFRESH_SKEW_MS) return session;

  if (isCoolingDown(session.refreshToken)) {
    return session.expiresAt > Date.now() ? session : null;
  }

  return await refreshAuthSession(session, config);
}

export async function refreshAuthSession(
  session: AuthSession,
  config: OAuthConfig,
): Promise<AuthSession | null> {
  const pending = inFlightRefreshes.get(session.refreshToken);
  if (pending) return pending;

  const refresh = (async (): Promise<AuthSession | null> => {
    let rotated: AuthSession | null = null;
    try {
      const token = await refreshAccessToken(config, session.refreshToken);

      rotated = {
        ...session,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
      await persistSession(rotated, config);

      const user = await fetchOAuthUser(config, token.access_token);
      const next: AuthSession = {
        ...rotated,
        userId: user.id,
        username: user.username,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      };
      await persistSession(next, config);
      transientFailures.delete(session.refreshToken);
      return next;
    } catch (err) {
      if (rotated) {
        noteTransientFailure(rotated.refreshToken);
        return rotated;
      }

      if (err instanceof OAuthTokenError && err.isPermanent) {
        await clearSession();
        return null;
      }

      noteTransientFailure(session.refreshToken);
      return session.expiresAt > Date.now() ? session : null;
    }
  })();

  inFlightRefreshes.set(session.refreshToken, refresh);
  try {
    return await refresh;
  } finally {
    inFlightRefreshes.delete(session.refreshToken);
  }
}

export async function createAuthSessionFromCode(code: string): Promise<AuthSession | null> {
  const config = readOAuthConfig();
  if (!config) return null;
  const token = await exchangeAuthorizationCode(config, code);
  const user = await fetchOAuthUser(config, token.access_token);
  return {
    userId: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}
