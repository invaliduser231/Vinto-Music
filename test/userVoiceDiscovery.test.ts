import test from 'node:test';
import assert from 'node:assert/strict';

import { findUserVoiceBinding } from '../src/dashboard/viewerAccess.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

test('findUserVoiceBinding returns voice channel for allowed guild', () => {
  const store = new VoiceStateStore();
  store.guildVoiceStates.set('guild-b', new Map([
    ['user-1', 'vc-right'],
  ]));

  const binding = findUserVoiceBinding(store, 'user-1', ['guild-a', 'guild-b']);
  assert.deepEqual(binding, { guildId: 'guild-b', voiceChannelId: 'vc-right' });
});

test('findUserVoiceBinding ignores guilds outside allow list', () => {
  const store = new VoiceStateStore();
  store.guildVoiceStates.set('guild-other', new Map([
    ['user-1', 'vc-1'],
  ]));

  const binding = findUserVoiceBinding(store, 'user-1', ['guild-allowed']);
  assert.equal(binding, null);
});
