import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';

function buildEnv(overrides: Record<string, string> = {}) {
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

test('loadConfig defaults YOUTUBE_PLAYLIST_RESOLVER to ytdlp', () => {
  const config = loadConfig(buildEnv());
  assert.equal(config.youtubePlaylistResolver, 'ytdlp');
});

test('loadConfig accepts playdl and auto for YOUTUBE_PLAYLIST_RESOLVER', () => {
  const playdlConfig = loadConfig(buildEnv({
    YOUTUBE_PLAYLIST_RESOLVER: 'playdl',
  }));
  const autoConfig = loadConfig(buildEnv({
    YOUTUBE_PLAYLIST_RESOLVER: 'auto',
  }));

  assert.equal(playdlConfig.youtubePlaylistResolver, 'playdl');
  assert.equal(autoConfig.youtubePlaylistResolver, 'ytdlp');
});

test('loadConfig rejects invalid YOUTUBE_PLAYLIST_RESOLVER values', () => {
  assert.throws(
    () => loadConfig(buildEnv({ YOUTUBE_PLAYLIST_RESOLVER: 'invalid' })),
    /YOUTUBE_PLAYLIST_RESOLVER must be one of: ytdlp, playdl, auto/
  );
});





