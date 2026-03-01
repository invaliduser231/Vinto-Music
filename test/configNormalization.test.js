import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

function buildEnv(overrides = {}) {
  return {
    BOT_TOKEN: 'test-token',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
    ...overrides,
  };
}

test('loadConfig normalizes Fluxer API/Gateway URLs and intents', () => {
  const config = loadConfig(buildEnv({
    API_BASE: 'api.fluxer.app',
    GATEWAY_URL: 'https://gateway.fluxer.app/',
    GATEWAY_INTENTS: '513',
  }));

  assert.equal(config.apiBase, 'https://api.fluxer.app/v1');
  assert.equal(config.gatewayUrl, 'wss://gateway.fluxer.app');
  assert.equal(config.gatewayIntents, 513);
});

test('loadConfig falls back to official API base for app/web URLs', () => {
  const config = loadConfig(buildEnv({
    API_BASE: 'https://app.fluxer.app/api',
    GATEWAY_URL: 'https://app.fluxer.app/gateway',
  }));

  assert.equal(config.apiBase, 'https://api.fluxer.app/v1');
  assert.equal(config.gatewayUrl, 'wss://gateway.fluxer.app');
});
