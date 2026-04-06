import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/gateway.ts';
import {
  extractSpotifyEntity,
  isDeezerUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isYouTubeUrl,
} from '../src/player/musicPlayer/trackUtils.ts';

test('strict host checks reject lookalike music domains', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=demo1234567'), true);
  assert.equal(isYouTubeUrl('https://youtube.com.evil.example/watch?v=demo1234567'), false);

  assert.equal(isSoundCloudUrl('https://on.soundcloud.com/abc123'), true);
  assert.equal(isSoundCloudUrl('https://on.soundcloud.com.evil.example/abc123'), false);

  assert.equal(isDeezerUrl('https://link.deezer.com/s/example'), true);
  assert.equal(isDeezerUrl('https://link.deezer.com.evil.example/s/example'), false);

  assert.equal(isSpotifyUrl('https://open.spotify.com/track/abc123'), true);
  assert.equal(isSpotifyUrl('https://spotify.com.evil.example/track/abc123'), false);
  assert.equal(extractSpotifyEntity('https://spotify.link/example'), null);
  assert.equal(extractSpotifyEntity('https://spotify.link.evil.example/track/abc123'), null);
});

test('gateway clamps oversized heartbeat intervals before scheduling timers', () => {
  const gateway = new Gateway({
    url: 'wss://gateway.example.test',
    token: 'test-token',
  });

  gateway.heartbeatIntervalMs = 10_000_000;
  gateway.ws = { readyState: 0 } as never;
  gateway._startHeartbeat();

  assert.equal(gateway.heartbeatIntervalMs, 10_000_000);
  assert.ok(gateway.heartbeatStartTimeoutHandle);

  gateway._clearTimers();
});
