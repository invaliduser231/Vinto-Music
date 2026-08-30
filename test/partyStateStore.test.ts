import test from 'node:test';
import assert from 'node:assert/strict';

import { partyStateStore } from '../src/bot/services/partyStateStore.ts';

test('party state is shared and prevents duplicate daily votes', () => {
  const guildId = `party-${Date.now()}`;
  partyStateStore.start(guildId);

  const joined = partyStateStore.join(guildId, 'user-1', 'a');
  assert.equal(joined?.teams.a, 1);

  const firstVote = partyStateStore.vote(guildId, 'user-1', 'a', new Date('2026-08-30T10:00:00Z'));
  const duplicateVote = partyStateStore.vote(guildId, 'user-1', 'b', new Date('2026-08-30T20:00:00Z'));
  assert.equal(firstVote.snapshot?.scores.a, 1);
  assert.equal(duplicateVote.alreadyVoted, true);
  assert.equal(duplicateVote.snapshot?.scores.b, 0);

  assert.equal(partyStateStore.end(guildId), true);
  assert.equal(partyStateStore.get(guildId), null);
});
