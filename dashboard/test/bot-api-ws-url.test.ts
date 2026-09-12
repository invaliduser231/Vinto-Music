import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfiguredWebSocketUrl } from '../src/lib/bot-api';

test('an unset ws url falls back to same origin', () => {
  delete process.env.DASHBOARD_WS_URL;
  assert.equal(readConfiguredWebSocketUrl(), null);
});

test('a configured ws url is used verbatim without a trailing slash', () => {
  process.env.DASHBOARD_WS_URL = 'wss://vinto.example.com/ws/';
  assert.equal(readConfiguredWebSocketUrl(), 'wss://vinto.example.com/ws');
});

test('plain ws is accepted for local setups', () => {
  process.env.DASHBOARD_WS_URL = 'ws://127.0.0.1:9092';
  assert.equal(readConfiguredWebSocketUrl(), 'ws://127.0.0.1:9092');
});

test('a non websocket scheme is rejected rather than handed to the browser', () => {
  for (const value of ['https://vinto.example.com', 'vinto.example.com', 'javascript:alert(1)', '   ']) {
    process.env.DASHBOARD_WS_URL = value;
    assert.equal(readConfiguredWebSocketUrl(), null, `must reject ${value}`);
  }
  delete process.env.DASHBOARD_WS_URL;
});
