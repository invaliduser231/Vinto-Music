import { cookies } from 'next/headers';
import { createOAuthState, OAUTH_STATE_COOKIE, sealValue } from '@/lib/auth-cookie';
import { buildAuthorizeUrl } from '@/lib/fluxer-oauth';
import { readOAuthConfig } from '@/lib/oauth-config';

export async function GET() {
  const config = readOAuthConfig();
  if (!config) {
    return Response.json({ error: 'oauth not configured' }, { status: 503 });
  }

  const state = createOAuthState();
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, sealValue(JSON.stringify(state), config.cookieSecret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });

  return Response.redirect(buildAuthorizeUrl(config, state));
}
