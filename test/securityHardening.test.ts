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

test('gateway logs non-recoverable close reasons', () => {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const gateway = new Gateway({
    url: 'wss://gateway.example.test',
    token: 'test-token',
    logger: {
      error(message, meta) {
        errors.push(meta ? { message, meta } : { message });
      },
    },
  });

  gateway._handleClose(4012, 'invalid api version');

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, 'Gateway closed with non-recoverable code, reconnect aborted');
  assert.equal(errors[0]?.meta?.code, 4012);
  assert.equal(errors[0]?.meta?.reason, 'invalid api version');
});

test('gateway treats Fluxer ack-backpressure closes as recoverable', () => {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const gateway = new Gateway({
    url: 'wss://gateway.example.test',
    token: 'test-token',
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    logger: {
      error(message, meta) {
        errors.push(meta ? { message, meta } : { message });
      },
    },
  });

  gateway._handleClose(4013, 'Acknowledgement backlog exceeded');

  assert.equal(errors.length, 0);
  assert.ok(gateway.reconnectTimeoutHandle);

  gateway._clearTimers();
});

test('gateway sends throttled heartbeat acks when dispatch sequence advances', () => {
  const sent: string[] = [];
  const gateway = new Gateway({
    url: 'wss://gateway.example.test',
    token: 'test-token',
  });

  gateway.ws = {
    readyState: 1,
    on() {},
    close() {},
    terminate() {},
    send(data: string) {
      sent.push(data);
    },
  };

  gateway._handlePacket({
    op: 0,
    t: 'READY',
    s: 1,
    d: { session_id: 'session-1', user: { username: 'Vinto' } },
  });

  assert.deepEqual(JSON.parse(sent[0] ?? '{}'), { op: 1, d: 1 });

  gateway._handlePacket({ op: 11 });
  gateway.lastSequenceAckSentAt = Date.now() - 1_000;
  gateway._handlePacket({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} });

  assert.deepEqual(JSON.parse(sent[1] ?? '{}'), { op: 1, d: 2 });
});
