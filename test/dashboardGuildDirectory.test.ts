import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGuildDirectory } from '../src/dashboard/guildDirectory.ts';

test('buildGuildDirectory groups and sorts searchable guild entities', () => {
  const directory = buildGuildDirectory(
    [
      { id: 'role-2', name: 'Listeners' },
      { id: 'role-1', name: 'DJ' },
      { id: '', name: 'Invalid' },
    ],
    [
      { id: 'voice-1', name: 'Lounge', type: 2 },
      { id: 'text-2', name: 'music-log', type: 0 },
      { id: 'text-1', name: 'announcements', type: 5 },
      { id: 'category-1', name: 'Music', type: 4 },
      { id: 'stage-1', name: 'Live', type: 13 },
    ],
    [
      { user: { id: 'user-2', username: 'Zoey' }, nick: 'Mixer' },
      { user: { id: 'bot-1', username: 'Vinto', bot: true } },
      { user: { id: 'user-1', username: 'Alex' } },
    ],
  );

  assert.deepEqual(directory.roles, [
    { id: 'role-1', name: 'DJ' },
    { id: 'role-2', name: 'Listeners' },
  ]);
  assert.deepEqual(directory.textChannels, [
    { id: 'text-1', name: 'announcements' },
    { id: 'text-2', name: 'music-log' },
  ]);
  assert.deepEqual(directory.voiceChannels, [
    { id: 'stage-1', name: 'Live' },
    { id: 'voice-1', name: 'Lounge' },
  ]);
  assert.deepEqual(directory.members, [
    { id: 'user-1', name: 'Alex' },
    { id: 'user-2', name: 'Mixer' },
  ]);
});
