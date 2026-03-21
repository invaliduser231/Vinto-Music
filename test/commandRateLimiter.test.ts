import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRateLimiter } from '../src/bot/services/commandRateLimiter.ts';

test('rate limiter blocks user when per-user window exceeded', () => {
  const limiter = new CommandRateLimiter({
    enabled: true,
    userWindowMs: 10_000,
    userMaxCommands: 2,
    guildWindowMs: 10_000,
    guildMaxCommands: 100,
    bypassCommands: [],
  });

  const base = { guildId: 'g1', userId: 'u1', commandName: 'play' };
  assert.equal(limiter.consume(base).allowed, true);
  assert.equal(limiter.consume(base).allowed, true);

  const blocked = limiter.consume(base);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'user');
  assert.ok((blocked.retryAfterMs ?? 0) > 0);
});

test('rate limiter bypasses configured commands', () => {
  const limiter = new CommandRateLimiter({
    enabled: true,
    userWindowMs: 10_000,
    userMaxCommands: 1,
    guildWindowMs: 10_000,
    guildMaxCommands: 1,
    bypassCommands: ['help'],
  });

  const first = limiter.consume({ guildId: 'g1', userId: 'u1', commandName: 'help' });
  const second = limiter.consume({ guildId: 'g1', userId: 'u1', commandName: 'help' });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});





