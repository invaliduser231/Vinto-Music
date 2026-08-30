import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRequesterProfiles,
  collectRequesterIds,
  parseMemberProfile,
} from '../src/dashboard/memberProfile.ts';

test('parseMemberProfile reads username and avatar from nested user payload', () => {
  const profile = parseMemberProfile({
    user: {
      id: '123',
      username: 'rainer',
      global_name: 'Rainer',
      avatar: 'avatarhash',
    },
  });

  assert.ok(profile);
  assert.equal(profile.id, '123');
  assert.equal(profile.username, 'Rainer');
  assert.equal(profile.avatarUrl, 'https://fluxerusercontent.com/avatars/123/avatarhash.png');
});

test('collectRequesterIds gathers ids from now playing and queue', () => {
  const ids = collectRequesterIds({
    nowPlaying: { requestedBy: 'user-1' },
    queue: [{ requestedBy: 'user-2' }, { requestedBy: 'user-1' }],
  });
  assert.deepEqual(ids.sort(), ['user-1', 'user-2']);
});

test('applyRequesterProfiles fills display fields on tracks', () => {
  const payload = {
    nowPlaying: {
      requestedBy: 'user-1',
      requestedByName: null,
      requestedByAvatarUrl: null,
    },
    queue: [{
      requestedBy: 'user-2',
      requestedByName: null,
      requestedByAvatarUrl: null,
    }],
  };
  const profiles = new Map([
    ['user-1', { id: 'user-1', username: 'Rainer', avatarUrl: 'https://example.com/a.png' }],
    ['user-2', { id: 'user-2', username: 'Alex', avatarUrl: 'https://example.com/b.png' }],
  ]);

  applyRequesterProfiles(payload, profiles);
  assert.equal(payload.nowPlaying?.requestedByName, 'Rainer');
  assert.equal(payload.queue[0]!.requestedByName, 'Alex');
});
