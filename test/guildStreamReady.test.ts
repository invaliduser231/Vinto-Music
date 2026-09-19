import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForGuildStreamSettled } from '../src/app/guildStreamReady.ts';

function createGateway() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    on(event: string, listener: () => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
  };
}

test('the wait ends as soon as every announced guild has arrived', async () => {
  const gateway = createGateway();
  const settled = waitForGuildStreamSettled(gateway, {
    expected: 3,
    quietMs: 5_000,
    maxWaitMs: 10_000,
  });

  gateway.emit('GUILD_CREATE');
  gateway.emit('GUILD_CREATE');
  gateway.emit('GUILD_CREATE');

  const result = await settled;
  assert.equal(result.reason, 'complete');
  assert.equal(result.received, 3);
  assert.equal(gateway.listenerCount('GUILD_CREATE'), 0, 'the listener must be released again');
});

test('a guild stream that stops short still releases the wait', async () => {
  const gateway = createGateway();
  const settled = waitForGuildStreamSettled(gateway, {
    expected: 50,
    quietMs: 30,
    maxWaitMs: 10_000,
  });

  gateway.emit('GUILD_CREATE');

  const result = await settled;
  assert.equal(result.reason, 'quiet');
  assert.equal(result.received, 1);
  assert.equal(gateway.listenerCount('GUILD_CREATE'), 0);
});

test('a never ending stream is capped by the maximum wait', async () => {
  const gateway = createGateway();
  const settled = waitForGuildStreamSettled(gateway, {
    expected: 100_000,
    quietMs: 20,
    maxWaitMs: 60,
  });

  const ticker = setInterval(() => gateway.emit('GUILD_CREATE'), 5);
  const result = await settled;
  clearInterval(ticker);

  assert.equal(result.reason, 'timeout');
  assert.ok(result.waitedMs >= 60);
  assert.equal(gateway.listenerCount('GUILD_CREATE'), 0);
});

test('a bot without announced guilds does not wait for the full timeout', async () => {
  const gateway = createGateway();
  const startedAt = Date.now();

  const result = await waitForGuildStreamSettled(gateway, {
    expected: 0,
    quietMs: 20,
    maxWaitMs: 10_000,
  });

  assert.equal(result.reason, 'quiet');
  assert.equal(result.received, 0);
  assert.ok(Date.now() - startedAt < 5_000, 'an empty stream must not block the restore');
});
