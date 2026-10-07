import test from 'node:test';
import assert from 'node:assert/strict';

import { TimeoutError } from '../src/core/errors.ts';
import { withTimeout } from '../src/utils/timeout.ts';

test('withTimeout resolves with the value of a promise that settles in time', async () => {
  assert.equal(await withTimeout(Promise.resolve('done'), 1_000, 'too slow'), 'done');
});

test('withTimeout passes through the original rejection', async () => {
  const failure = new Error('request failed');
  await assert.rejects(withTimeout(Promise.reject(failure), 1_000, 'too slow'), failure);
});

test('withTimeout rejects with a TimeoutError once the deadline passes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = withTimeout(new Promise<never>(() => {}), 5_000, 'playlist fetch timed out');

  t.mock.timers.tick(5_000);

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof TimeoutError);
    assert.equal(err.message, 'playlist fetch timed out');
    assert.equal(err.code, 'ETIMEDOUT');
    return true;
  });
});
