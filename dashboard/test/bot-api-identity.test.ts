import test from 'node:test';
import assert from 'node:assert/strict';

import { stripClientIdentity } from '../src/lib/bot-api';

test('the proxy drops a client supplied user id and role ids', () => {
  const body = JSON.stringify({
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    action: 'skip',
    userId: 'someone-else',
    roleIds: ['dj-role'],
  });

  assert.deepEqual(JSON.parse(stripClientIdentity(body)), {
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    action: 'skip',
  });
});

test('bodies without identity fields pass through unchanged', () => {
  const body = JSON.stringify({ patch: { prefix: '?' } });
  assert.equal(stripClientIdentity(body), body);
});

test('non object bodies are forwarded as they are', () => {
  assert.equal(stripClientIdentity(''), '');
  assert.equal(stripClientIdentity('not json'), 'not json');
  assert.equal(stripClientIdentity('["userId"]'), '["userId"]');
});
