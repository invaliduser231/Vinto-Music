import test from 'node:test';
import assert from 'node:assert/strict';
import { readOAuthConfig } from '../src/lib/oauth-config';

const REQUIRED_ENV = {
  FLUXER_OAUTH_CLIENT_ID: '1474774210677452817',
  FLUXER_OAUTH_CLIENT_SECRET: 'test-client-secret',
  FLUXER_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  AUTH_COOKIE_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  FLUXER_API_BASE: 'https://api.fluxer.app/v1',
};

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('readOAuthConfig uses web app authorize and root token endpoints', () => {
  const snapshot = { ...process.env };
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
  delete process.env.FLUXER_OAUTH_AUTHORIZE_URL;
  delete process.env.FLUXER_OAUTH_TOKEN_URL;

  const config = readOAuthConfig();
  assert.ok(config);
  assert.equal(config.authorizeUrl, 'https://web.fluxer.app/oauth2/authorize');
  assert.equal(config.tokenUrl, 'https://api.fluxer.app/oauth2/token');
  assert.equal(config.apiBase, 'https://api.fluxer.app/v1');

  restoreEnv(snapshot);
});
