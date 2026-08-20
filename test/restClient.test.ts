import test from 'node:test';
import assert from 'node:assert/strict';

import { RestClient, RestError } from '../src/rest.ts';

type JsonResponseOptions = {
  status?: number;
  headers?: Record<string, string>;
};

function jsonResponse(body: unknown, options: JsonResponseOptions = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

test('getGatewayBot falls back to /gateway when /gateway/bot returns 404', async () => {
  const originalFetch = global.fetch;
  const seenUrls: string[] = [];
  let call = 0;

  global.fetch = async (url) => {
    seenUrls.push(String(url));
    call += 1;
    if (call === 1) {
      return jsonResponse({ code: 'NOT_FOUND', message: 'missing' }, { status: 404 });
    }
    return jsonResponse({ url: 'wss://gateway.fluxer.app' }, { status: 200 });
  };

  try {
    const rest = new RestClient({
      token: 'test-token',
      base: 'https://api.fluxer.app/v1',
      maxRetries: 1,
    });
    const gateway = await rest.getGatewayBot() as { url: string };
    assert.equal(gateway.url, 'wss://gateway.fluxer.app');
    assert.deepEqual(seenUrls, [
      'https://api.fluxer.app/v1/gateway/bot',
      'https://api.fluxer.app/v1/gateway',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('global 429 sets temporary global throttle for next request', async () => {
  const originalFetch = global.fetch;
  let call = 0;

  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return jsonResponse({
        code: 'RATE_LIMITED',
        message: 'global limit',
        retry_after: 0.2,
        global: true,
      }, { status: 429 });
    }
    return jsonResponse({ id: '123', username: 'bot' }, { status: 200 });
  };

  try {
    const rest = new RestClient({
      token: 'test-token',
      base: 'https://api.fluxer.app/v1',
      maxRetries: 1,
    });

    await assert.rejects(
      () => rest.getCurrentUser(),
      (error) => error instanceof RestError && error.status === 429 && error.globalRateLimit === true
    );

    const startedAt = Date.now();
    const user = await rest.getCurrentUser() as { username: string };
    const elapsedMs = Date.now() - startedAt;

    assert.equal(user.username, 'bot');
    assert.ok(elapsedMs >= 150, `expected global throttle wait >=150ms, got ${elapsedMs}ms`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('editMessage does not retry transient PATCH failures', async () => {
  const originalFetch = global.fetch;
  let call = 0;

  global.fetch = async () => {
    call += 1;
    throw new Error('socket timeout');
  };

  try {
    const rest = new RestClient({
      token: 'test-token',
      base: 'https://api.fluxer.app/v1',
      maxRetries: 4,
    });

    await assert.rejects(
      () => rest.editMessage('channel-1', 'message-1', { content: 'hello' }),
      (error) => error instanceof RestError && error.status == null
    );
    assert.equal(call, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGuild does not retry known disabled_operations validation 500 responses', async () => {
  const originalFetch = global.fetch;
  let call = 0;

  global.fetch = async () => {
    call += 1;
    return jsonResponse({
      code: 'RESPONSE_VALIDATION_ERROR',
      message: 'Response validation failed: disabled_operations: INVALID_FORMAT.',
    }, { status: 500 });
  };

  try {
    const rest = new RestClient({
      token: 'test-token',
      base: 'https://api.fluxer.app/v1',
      maxRetries: 4,
    });

    await assert.rejects(
      () => rest.getGuild('guild-1'),
      (error) => error instanceof RestError
        && error.status === 500
        && error.retryable === false
    );
    assert.equal(call, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('disconnectMemberFromVoice patches the member voice channel to null', async () => {
  const originalFetch = global.fetch;
  let method = '';
  let url = '';
  let body: Record<string, unknown> | null = null;

  global.fetch = async (requestUrl, init) => {
    method = String(init?.method ?? '');
    url = String(requestUrl);
    body = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ ok: true }, { status: 200 });
  };

  try {
    const rest = new RestClient({
      token: 'test-token',
      base: 'https://api.fluxer.app/v1',
      maxRetries: 1,
    });

    await rest.disconnectMemberFromVoice('guild-7', 'user-9');
    assert.equal(method, 'PATCH');
    assert.equal(url, 'https://api.fluxer.app/v1/guilds/guild-7/members/user-9');
    assert.deepEqual(body, { channel_id: null });
  } finally {
    global.fetch = originalFetch;
  }
});





