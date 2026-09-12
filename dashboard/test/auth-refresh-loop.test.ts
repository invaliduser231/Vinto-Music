import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_SESSION_COOKIE, sealAuthSession, type AuthSession } from '../src/lib/auth-cookie';

const COOKIE_SECRET = 'a'.repeat(48);

process.env.FLUXER_OAUTH_CLIENT_ID = 'client-id';
process.env.FLUXER_OAUTH_CLIENT_SECRET = 'client-secret';
process.env.FLUXER_OAUTH_REDIRECT_URI = 'https://dashboard.test/api/auth/callback';
process.env.AUTH_COOKIE_SECRET = COOKIE_SECRET;

const jar = new Map<string, string>();

mock.module('next/headers', {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
      set: (name: string, value: string) => { jar.set(name, value); },
      delete: (name: string) => { jar.delete(name); },
    }),
  },
});

let tokenCalls = 0;
let tokenStatus = 400;
let profileOk = true;

globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.includes('/oauth2/token')) {
    tokenCalls += 1;
    if (tokenStatus >= 400) {
      return { ok: false, status: tokenStatus, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'identify guilds',
      }),
    } as unknown as Response;
  }
  if (!profileOk) {
    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'user-1', username: 'user', avatar: null }),
  } as unknown as Response;
}) as unknown as typeof fetch;

function seedExpiringSession(refreshToken: string) {
  jar.clear();
  const session: AuthSession = {
    userId: 'user-1',
    username: 'user',
    accessToken: 'access',
    refreshToken,
    expiresAt: Date.now() + 5_000,
  };
  jar.set(AUTH_SESSION_COOKIE, sealAuthSession(session, COOKIE_SECRET));
}

const { getAuthSession } = await import('../src/lib/auth-server');

test('a rejected refresh token is not retried on every request', async () => {
  seedExpiringSession('dead-token-permanent');
  tokenStatus = 400;
  profileOk = true;
  tokenCalls = 0;

  for (let i = 0; i < 25; i += 1) await getAuthSession();

  assert.equal(
    tokenCalls,
    1,
    `a 400 must end the loop, but the token endpoint was hit ${tokenCalls} times`,
  );
});

test('a permanently rejected session is cleared so the browser stops sending it', async () => {
  seedExpiringSession('dead-token-cleared');
  tokenStatus = 400;
  profileOk = true;
  tokenCalls = 0;

  const result = await getAuthSession();

  assert.equal(result, null, 'the session must be dropped');
  assert.equal(jar.has(AUTH_SESSION_COOKIE), false, 'the cookie must be deleted');
});

test('a transient failure keeps the session but retries on a cooldown', async () => {
  seedExpiringSession('token-transient');
  tokenStatus = 503;
  profileOk = true;
  tokenCalls = 0;

  const first = await getAuthSession();
  assert.ok(first, 'a 503 must not log the user out');

  for (let i = 0; i < 20; i += 1) await getAuthSession();

  assert.equal(
    tokenCalls,
    1,
    `a 503 must be retried on a cooldown, not per request, but saw ${tokenCalls} calls`,
  );
});

test('a rotated refresh token survives a failing profile lookup', async () => {
  seedExpiringSession('token-to-rotate');
  tokenStatus = 200;
  profileOk = false;
  tokenCalls = 0;

  const session = await getAuthSession();

  assert.ok(session, 'the refreshed session must be kept');
  assert.equal(
    session?.refreshToken,
    'rotated-refresh',
    'the rotated token must be stored, otherwise the consumed one is retried forever',
  );

  for (let i = 0; i < 10; i += 1) await getAuthSession();
  assert.equal(tokenCalls, 1, `the token endpoint must not be hammered, saw ${tokenCalls}`);
});
