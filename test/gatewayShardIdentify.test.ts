import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/gateway.ts';

function captureIdentify(options: Record<string, unknown>) {
  const gateway = new Gateway({
    url: 'wss://gateway.example/',
    token: 'token',
    logger: null,
    ...options,
  } as never) as never as {
    _identify: () => void;
    _send: (op: number, payload: unknown) => void;
  };

  const sent: Array<{ op: number; payload: Record<string, unknown> }> = [];
  gateway._send = (op, payload) => {
    sent.push({ op, payload: payload as Record<string, unknown> });
  };
  gateway._identify();
  return sent[0]?.payload ?? {};
}

test('a single shard identifies without a shard field', () => {
  const payload = captureIdentify({});
  assert.equal('shard' in payload, false, 'an unsharded bot must not announce a shard');
});

test('a sharded bot announces its position', () => {
  const payload = captureIdentify({ shardId: 1, shardCount: 3 });
  assert.deepEqual(payload.shard, [1, 3]);
});

test('a shard id beyond the count is clamped instead of identifying wrong', () => {
  const payload = captureIdentify({ shardId: 9, shardCount: 2 });
  assert.deepEqual(payload.shard, [1, 2]);
});

test('the token and intents survive next to the shard', () => {
  const payload = captureIdentify({ shardId: 0, shardCount: 2, intents: 512 });
  assert.equal(payload.token, 'token');
  assert.equal(payload.intents, 512);
  assert.deepEqual(payload.shard, [0, 2]);
});
