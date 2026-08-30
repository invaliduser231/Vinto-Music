import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  AUTH_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  openValue,
  sealAuthSession,
} from '@/lib/auth-cookie';
import { createAuthSessionFromCode } from '@/lib/auth-server';
import { readOAuthConfig } from '@/lib/oauth-config';

function redirectHome(): NextResponse {
  return new NextResponse(null, { status: 302, headers: { location: '/' } });
}

export async function GET(request: Request) {
  const config = readOAuthConfig();
  if (!config) return redirectHome();

  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') ?? '').trim();
  const state = String(url.searchParams.get('state') ?? '').trim();
  const store = await cookies();
  const stateCookie = store.get(OAUTH_STATE_COOKIE)?.value;
  const expectedState = stateCookie ? openValue<string>(stateCookie, config.cookieSecret) : null;
  store.delete(OAUTH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectHome();
  }

  try {
    const session = await createAuthSessionFromCode(code);
    if (!session) return redirectHome();

    store.set(AUTH_SESSION_COOKIE, sealAuthSession(session, config.cookieSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return redirectHome();
  } catch {
    return redirectHome();
  }
}
