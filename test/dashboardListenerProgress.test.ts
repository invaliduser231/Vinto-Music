import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveListenerProgressSec } from '../src/dashboard/sessionSnapshot.ts';

type Args = Parameters<typeof resolveListenerProgressSec>;

function build(progressMs: number | null, playoutDelayMs: unknown, seconds?: number) {
  const player = {
    ...(progressMs == null ? {} : { getProgressMs: () => progressMs }),
    ...(seconds == null ? {} : { getProgressSeconds: () => seconds }),
  } as Args[1];
  const session = { connection: { playoutDelayMs } } as unknown as Args[0];
  return { session, player };
}

test('the reported position is what listeners hear, not what was buffered', () => {
  const { session, player } = build(42_000, 550);
  assert.equal(resolveListenerProgressSec(session, player), 41.45);
});

test('the position keeps sub-second precision so lyrics can line up', () => {
  const { session, player } = build(41_800, 0);
  assert.equal(resolveListenerProgressSec(session, player), 41.8);
});

test('an empty buffer means no compensation', () => {
  const { session, player } = build(30_000, 0);
  assert.equal(resolveListenerProgressSec(session, player), 30);
});

test('the position never goes negative at the very start of a track', () => {
  const { session, player } = build(200, 900);
  assert.equal(resolveListenerProgressSec(session, player), 0);
});

test('a missing or broken buffer reading is treated as no delay', () => {
  for (const value of [undefined, null, Number.NaN, 'nonsense', -500]) {
    const { session, player } = build(10_000, value);
    assert.equal(resolveListenerProgressSec(session, player), 10, `failed for ${String(value)}`);
  }
});

test('an older player without the precise accessor still reports whole seconds', () => {
  const { session, player } = build(null, 550, 41);
  assert.equal(resolveListenerProgressSec(session, player), 41);
});

test('a session without a voice connection does not throw', () => {
  const player = { getProgressMs: () => 5_000 } as Args[1];
  const session = { connection: null } as unknown as Args[0];
  assert.equal(resolveListenerProgressSec(session, player), 5);
});
