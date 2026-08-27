import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { LastFmApiError, LastFmClient } from '../src/integrations/lastfm/LastFmClient.ts';

type FetchCall = { url: string; method: string; body: string | null };

function createClient() {
  return new LastFmClient({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    requestTimeoutMs: 1_000,
    requestsPerSecond: 1_000,
  });
}

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = (async (input: unknown, init?: Record<string, unknown>) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body: init?.body != null ? String(init.body) : null,
    });

    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return {
      ok: (response?.status ?? 200) < 400,
      status: response?.status ?? 200,
      text: async () => JSON.stringify(response?.body ?? {}),
    };
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('the signature follows the documented sorted concatenation', () => {
  const client = createClient();
  const signature = client.signature({
    method: 'auth.getSession',
    api_key: 'test-key',
    token: 'abc',
    format: 'json',
  });

  const expected = createHash('md5')
    .update('api_keytest-keymethodauth.getSessiontokenabctest-secret', 'utf8')
    .digest('hex');

  assert.equal(signature, expected);
});

test('empty values stay out of the signature', () => {
  const client = createClient();
  const withEmpty = client.signature({ method: 'track.scrobble', album: '', duration: null });
  const withoutEmpty = client.signature({ method: 'track.scrobble' });

  assert.equal(withEmpty, withoutEmpty);
});

test('reads go out as GET and writes as a signed POST', async () => {
  const stub = stubFetch([{ body: { user: { name: 'listener', playcount: '42' } } }]);
  try {
    const client = createClient();
    const info = await client.userGetInfo('listener');

    assert.equal(info.name, 'listener');
    assert.equal(info.playcount, 42);
    assert.equal(stub.calls[0]?.method, 'GET');
    assert.match(String(stub.calls[0]?.url), /user\.getInfo/);
    assert.doesNotMatch(String(stub.calls[0]?.url), /api_sig/);
  } finally {
    stub.restore();
  }
});

test('scrobbles are posted with indexed parameters and a signature', async () => {
  const stub = stubFetch([{ body: { scrobbles: { '@attr': { accepted: 1 } } } }]);
  try {
    const client = createClient();
    const accepted = await client.scrobble('session-key', [
      { artist: 'M83', track: 'Midnight City', timestamp: 1_700_000_000, album: null, duration: 243 },
    ]);

    assert.equal(accepted, 1);
    assert.equal(stub.calls[0]?.method, 'POST');

    const body = new URLSearchParams(String(stub.calls[0]?.body));
    assert.equal(body.get('artist[0]'), 'M83');
    assert.equal(body.get('track[0]'), 'Midnight City');
    assert.equal(body.get('timestamp[0]'), '1700000000');
    assert.equal(body.get('duration[0]'), '243');
    assert.equal(body.get('sk'), 'session-key');
    assert.ok(body.get('api_sig'));
  } finally {
    stub.restore();
  }
});

test('an api error code is surfaced as LastFmApiError', async () => {
  const stub = stubFetch([{ body: { error: 6, message: 'User not found' } }]);
  try {
    const client = createClient();
    await assert.rejects(
      () => client.userGetInfo('nobody'),
      (err: unknown) => err instanceof LastFmApiError && err.lastfmCode === 6,
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('auth failures are not retried', async () => {
  const stub = stubFetch([{ body: { error: 9, message: 'Invalid session key' } }]);
  try {
    const client = createClient();
    await assert.rejects(() => client.scrobble('stale-key', [
      { artist: 'a', track: 'b', timestamp: 1 },
    ]));
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('rate limit errors are retried', async () => {
  const stub = stubFetch([
    { body: { error: 29, message: 'Rate limit exceeded' } },
    { body: { error: 29, message: 'Rate limit exceeded' } },
    { body: { session: { name: 'listener', key: 'session-key' } } },
  ]);
  try {
    const client = createClient();
    const session = await client.getSession('token');

    assert.equal(session.name, 'listener');
    assert.equal(session.key, 'session-key');
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('single entry api responses are normalised into arrays', async () => {
  const stub = stubFetch([{
    body: {
      recenttracks: {
        track: {
          artist: { '#text': 'Boards of Canada' },
          name: 'Roygbiv',
          date: { uts: '1700000000' },
        },
      },
    },
  }]);
  try {
    const client = createClient();
    const recent = await client.userGetRecentTracks('listener', 1);

    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.artist, 'Boards of Canada');
    assert.equal(recent[0]?.track, 'Roygbiv');
    assert.equal(recent[0]?.nowPlaying, false);
  } finally {
    stub.restore();
  }
});

test('the auth url carries the api key and token', () => {
  const client = createClient();
  const url = new URL(client.buildAuthUrl('abc123'));

  assert.equal(url.origin + url.pathname, 'https://www.last.fm/api/auth/');
  assert.equal(url.searchParams.get('api_key'), 'test-key');
  assert.equal(url.searchParams.get('token'), 'abc123');
});
