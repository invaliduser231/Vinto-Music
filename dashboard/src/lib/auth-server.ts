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
  refreshAccessToken,
} from './fluxer-oauth';

const inFlightRefreshes = new Map<string, Promise<AuthSession | null>>();

export async function getAuthSession(): Promise<AuthSession | null> {
  const config = readOAuthConfig();
  if (!config) return null;
  const store = await cookies();
  const raw = store.get(AUTH_SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = openAuthSession(raw, config.cookieSecret);
  if (!session) return null;
  if (session.expiresAt <= Date.now() + 30_000) {
    return await refreshAuthSession(session, config);
  }
  return session;
}

export async function refreshAuthSession(
  session: AuthSession,
  config: OAuthConfig,
): Promise<AuthSession | null> {
  const pending = inFlightRefreshes.get(session.refreshToken);
  if (pending) return pending;

  const refresh = (async (): Promise<AuthSession | null> => {
    try {
      const token = await refreshAccessToken(config, session.refreshToken);
      const user = await fetchOAuthUser(config, token.access_token);
      const next: AuthSession = {
        userId: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
      const store = await cookies();
      store.set(AUTH_SESSION_COOKIE, sealAuthSession(next, config.cookieSecret), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      return next;
    } catch {
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
