import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOAuthGuildAllowed,
  shouldShowConnectPanel,
  shouldShowControls,
  shouldShowPlayer,
} from '../src/lib/session-visibility';

test('isOAuthGuildAllowed rejects guilds outside the oauth list', () => {
  const guilds = [{ id: 'guild-a', name: 'A' }];
  assert.equal(isOAuthGuildAllowed(true, 'guild-a', guilds), true);
  assert.equal(isOAuthGuildAllowed(true, 'serverworld', guilds), false);
  assert.equal(isOAuthGuildAllowed(true, '', guilds), true);
  assert.equal(isOAuthGuildAllowed(false, 'serverworld', guilds), true);
});

test('shouldShowPlayer follows voice membership unless mock mode is enabled', () => {
  assert.equal(shouldShowPlayer(false, false), false);
  assert.equal(shouldShowPlayer(false, true), true);
  assert.equal(shouldShowPlayer(true, false), true);
});

test('shouldShowControls hides dj controls without permission', () => {
  assert.equal(shouldShowControls(false, false), false);
  assert.equal(shouldShowControls(false, true), true);
  assert.equal(shouldShowControls(true, false), true);
});

test('shouldShowConnectPanel hides connect UI once the user is in voice', () => {
  assert.equal(shouldShowConnectPanel(false, false), true);
  assert.equal(shouldShowConnectPanel(false, true), false);
  assert.equal(shouldShowConnectPanel(true, false), false);
  assert.equal(shouldShowConnectPanel(true, true), false);
});
