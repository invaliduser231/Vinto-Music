import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { GuildStateCache } from '../src/bot/services/guildStateCache.ts';

function createCache() {
  const gateway = new EventEmitter();
  const cache = new GuildStateCache();
  cache.register(gateway);
  return { gateway, cache };
}

test('member counts come from the top level of guild create and follow member events', () => {
  const { gateway, cache } = createCache();

  gateway.emit('GUILD_CREATE', { id: '1', properties: { id: '1', owner_id: '9' }, roles: [], member_count: 10 });
  gateway.emit('GUILD_CREATE', { id: '2', properties: { id: '2' }, roles: [], member_count: 3 });
  gateway.emit('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: '50' } });
  gateway.emit('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: '51' } });
  gateway.emit('GUILD_MEMBER_REMOVE', { guild_id: '2', user: { id: '60' } });

  assert.deepEqual(cache.memberTotals(), { memberCount: 14, uncountedGuildCount: 0 });
  assert.equal(cache.resolveOwnerId('1'), '9');
});

test('a guild without a count stays uncounted until guild create delivers one', () => {
  const { gateway, cache } = createCache();

  gateway.emit('READY', { guilds: [{ id: '1', unavailable: true }, { id: '2', unavailable: true }] });
  gateway.emit('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: '50' } });
  assert.deepEqual(cache.memberTotals(), { memberCount: 0, uncountedGuildCount: 2 });

  gateway.emit('GUILD_CREATE', { id: '1', properties: { id: '1' }, roles: [], member_count: 4 });
  assert.deepEqual(cache.memberTotals(), { memberCount: 4, uncountedGuildCount: 1 });
});

test('guild updates keep the count and leaving a guild drops it', () => {
  const { gateway, cache } = createCache();

  gateway.emit('GUILD_CREATE', { id: '1', properties: { id: '1' }, roles: [], member_count: 8 });
  gateway.emit('GUILD_UPDATE', { id: '1', name: 'renamed' });
  assert.deepEqual(cache.memberTotals(), { memberCount: 8, uncountedGuildCount: 0 });

  gateway.emit('GUILD_DELETE', { id: '1' });
  assert.deepEqual(cache.memberTotals(), { memberCount: 0, uncountedGuildCount: 0 });
  assert.equal(cache.guildCount(), 0);
});

test('a member count never drops below zero', () => {
  const { gateway, cache } = createCache();

  gateway.emit('GUILD_CREATE', { id: '1', properties: { id: '1' }, roles: [], member_count: 1 });
  gateway.emit('GUILD_MEMBER_REMOVE', { guild_id: '1', user: { id: '1' } });
  gateway.emit('GUILD_MEMBER_REMOVE', { guild_id: '1', user: { id: '2' } });

  assert.deepEqual(cache.memberTotals(), { memberCount: 0, uncountedGuildCount: 0 });
});
