import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOAuthState,
  openAuthSession,
  openValue,
  sealAuthSession,
  sealValue,
} from '../src/lib/auth-cookie';

test('auth cookie seal and open roundtrip', () => {
  const secret = 'local-test-secret-at-least-32-chars';
  const session = {
    userId: 'user-1',
    username: 'tester',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
  };
  const sealed = sealAuthSession(session, secret);
  const opened = openAuthSession(sealed, secret);
  assert.deepEqual(opened, session);
});

test('auth cookie rejects tampered signature', () => {
  const secret = 'local-test-secret-at-least-32-chars';
  const sealed = sealValue('{"userId":"user-1"}', secret);
  const [body, sig] = sealed.split('.');
  const tampered = `${body}.${sig.slice(0, -1)}x`;
  assert.equal(openValue(tampered, secret), null);
});

test('oauth state cookie roundtrips when sealed as json', () => {
  const secret = 'local-test-secret-at-least-32-chars';
  const state = createOAuthState();
  const sealed = sealValue(JSON.stringify(state), secret);
  const opened = openValue<string>(sealed, secret);
  assert.equal(opened, state);
});
