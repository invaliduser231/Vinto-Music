import test from 'node:test';
import assert from 'node:assert/strict';

import { createErrorChannelReporter, redactErrorText } from '../src/monitoring/errorChannel.ts';

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('redactErrorText hides configured secrets and credential patterns', () => {
  const text = [
    'connect failed for mongodb://vinto:hunter2@mongo:27017/db',
    'GET https://api.example.com/x?api_key=abc123&page=2',
    'header authorization: supersecretvalue',
    'used token MTIzNDU2Nzg5MDEyMzQ1Njc4.abcdef.ghijklmnop',
  ].join('\n');

  const redacted = redactErrorText(text, ['MTIzNDU2Nzg5MDEyMzQ1Njc4.abcdef.ghijklmnop', 'abc']);

  assert.doesNotMatch(redacted, /hunter2/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /supersecretvalue/);
  assert.doesNotMatch(redacted, /MTIzNDU2/);
  assert.match(redacted, /page=2/);
});

test('error channel posts once per distinct error and forwards to the inner reporter', async () => {
  const posted: string[] = [];
  const inner: unknown[] = [];
  const reporter = createErrorChannelReporter({
    channelId: '1000001',
    rest: {
      async sendMessage(_channelId, payload) {
        posted.push(String(payload.content));
        return {};
      },
    },
    inner: { captureException: (error) => inner.push(error) },
    secrets: ['very-secret-token'],
    now: () => 1_000,
  });

  reporter?.captureException?.(new Error('boom with very-secret-token'), { source: 'command_router', command: 'play', guildId: '42' });
  reporter?.captureException?.(new Error('boom with very-secret-token'), { source: 'command_router', command: 'play', guildId: '42' });
  await flushMicrotasks();

  assert.equal(inner.length, 2);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /\*\*command_router\*\*/);
  assert.match(posted[0]!, /command=play guildId=42/);
  assert.doesNotMatch(posted[0]!, /very-secret-token/);
});

test('error channel caps posts per window', async () => {
  const posted: string[] = [];
  const reporter = createErrorChannelReporter({
    channelId: '1000001',
    rest: {
      async sendMessage(_channelId, payload) {
        posted.push(String(payload.content));
        return {};
      },
    },
    now: () => 5_000,
  });

  for (let index = 0; index < 15; index += 1) {
    reporter?.captureException?.(new Error(`failure ${index}`), { source: 'test' });
  }
  await flushMicrotasks();

  assert.equal(posted.length, 10);
});

test('without a channel the reporter falls back to the inner reporter', () => {
  const inner = { captureException() {} };
  assert.equal(createErrorChannelReporter({ channelId: null, rest: { async sendMessage() { return {}; } }, inner }), inner);
});
