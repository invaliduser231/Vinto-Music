import test from 'node:test';
import assert from 'node:assert/strict';

import { isGatewayRecovering, unhealthyExitThresholdMs } from '../src/app/unhealthyExit.ts';

const policy = { unhealthyExitAfterMs: 180_000, gatewayOutageExitAfterMs: 1_800_000 };
const now = 10_000_000;

test('a gateway that keeps scheduling reconnects gets the longer outage threshold', () => {
  const state = { gatewayConnected: false, lastGatewayReconnectActivityAtMs: now - 30_000, nowMs: now };

  assert.equal(isGatewayRecovering(state), true);
  assert.equal(unhealthyExitThresholdMs(policy, state), 1_800_000);
});

test('a gateway that stopped trying falls back to the short threshold', () => {
  const state = { gatewayConnected: false, lastGatewayReconnectActivityAtMs: now - 5 * 60_000, nowMs: now };

  assert.equal(isGatewayRecovering(state), false);
  assert.equal(unhealthyExitThresholdMs(policy, state), 180_000);
});

test('without any reconnect activity the short threshold applies', () => {
  const state = { gatewayConnected: false, lastGatewayReconnectActivityAtMs: null, nowMs: now };

  assert.equal(unhealthyExitThresholdMs(policy, state), 180_000);
});

test('a connected gateway never counts as recovering', () => {
  const state = { gatewayConnected: true, lastGatewayReconnectActivityAtMs: now, nowMs: now };

  assert.equal(isGatewayRecovering(state), false);
});

test('an outage threshold below the regular one never shortens it', () => {
  const state = { gatewayConnected: false, lastGatewayReconnectActivityAtMs: now, nowMs: now };

  assert.equal(unhealthyExitThresholdMs({ unhealthyExitAfterMs: 180_000, gatewayOutageExitAfterMs: 60_000 }, state), 180_000);
});
