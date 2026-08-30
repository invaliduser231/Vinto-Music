import { cookies } from 'next/headers';
import {
  AUTH_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  openValue,
  sealAuthSession,
} from '@/lib/auth-cookie';
import { createAuthSessionFromCode } from '@/lib/auth-server';
import { readOAuthConfig } from '@/lib/oauth-config';

export async function GET(request: Request) {
  const config = readOAuthConfig();
  if (!config) {
    return Response.redirect(new URL('/', request.url));
  }

  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') ?? '').trim();
  const state = String(url.searchParams.get('state') ?? '').trim();
  const store = await cookies();
  const stateCookie = store.get(OAUTH_STATE_COOKIE)?.value;
  const expectedState = stateCookie ? openValue<string>(stateCookie, config.cookieSecret) : null;
  store.delete(OAUTH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return Response.redirect(new URL('/', request.url));
  }

  try {
    const session = await createAuthSessionFromCode(code);
    if (!session) {
      return Response.redirect(new URL('/', request.url));
    }
    store.set(AUTH_SESSION_COOKIE, sealAuthSession(session, config.cookieSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return Response.redirect(new URL('/', request.url));
  } catch {
    return Response.redirect(new URL('/', request.url));
  }
}
