import test from 'node:test';
import assert from 'node:assert/strict';

import { persistentRestoreRetryDelayMs } from '../src/bot/sessionManager.ts';

test('the wait grows between attempts instead of staying instant', () => {
  const first = persistentRestoreRetryDelayMs(1);
  const second = persistentRestoreRetryDelayMs(2);
  assert.ok(second > first, `attempt 2 must wait longer than attempt 1 (${first} -> ${second})`);
});

test('even the first retry gives the gateway real time to settle', () => {
  assert.ok(
    persistentRestoreRetryDelayMs(1) >= 1_000,
    'a quarter second was never enough for a congested gateway',
  );
});

test('the wait is capped so a restore cannot stall forever', () => {
  for (const attempt of [5, 20, 1_000]) {
    assert.ok(
      persistentRestoreRetryDelayMs(attempt) <= 8_000,
      `attempt ${attempt} must stay capped`,
    );
  }
});

test('nonsense attempt numbers still produce a sane wait', () => {
  for (const attempt of [0, -3, Number.NaN]) {
    const value = persistentRestoreRetryDelayMs(attempt);
    assert.ok(
      Number.isFinite(value) && value >= 1_000 && value <= 8_000,
      `attempt ${attempt} produced ${value}`,
    );
  }
});
