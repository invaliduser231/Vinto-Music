import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type DeezerJsonResponse = {
  ok: true;
  status: number;
  headers: {
    getSetCookie(): string[];
    get(name?: string): string | null;
  };
  json(): Promise<unknown>;
};

type DeezerMediaRequestPayload = {
  media?: Array<{
    formats?: Array<{
      cipher?: string;
      format?: string;
    }>;
  }>;
};

function createPlayer(overrides = {}) {
  return new MusicPlayer({
    async sendAudio() {},
  }, {
    logger: null,
    deezerArl: 'dummy-arl-cookie',
    ...overrides,
  });
}

function jsonResponse(payload: unknown): DeezerJsonResponse {
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie() {
        return [];
      },
      get() {
        return null;
      },
    },
    async json() {
      return payload;
    },
  };
}

test('deezer media variant selection follows first-media-first-source order', () => {
  const player = createPlayer();

  const variant = player._resolveDeezerMediaVariantFromResponse({
    data: [
      {
        media: [{
          cipher: { type: 'BF_CBC_STRIPE' },
          format: 'MP3_128',
          sources: [
            { url: 'https://cdn-first.example/first' },
            { url: 'https://cdn-first.example/second' },
          ],
        }],
      },
      {
        media: [{
          cipher: { type: 'BF_CBC_STRIPE' },
          format: 'FLAC',
          sources: [{ url: 'https://cdn-second.example/flac' }],
        }],
      },
    ],
  });

  assert.deepEqual(variant, {
    url: 'https://cdn-first.example/first',
    cipherType: 'BF_CBC_STRIPE',
    format: 'MP3_128',
  });
});

test('deezer session tokens are cached with ttl', async () => {
  const player = createPlayer();
  let calls = 0;

  player._deezerGatewayCall = async () => {
    calls += 1;
    return {
      results: {
        checkForm: 'api-token-1',
        USER: {
          OPTIONS: {
            license_token: 'license-token-1',
          },
        },
      },
    };
  };

  const first = await player._getDeezerSessionTokens();
  const second = await player._getDeezerSessionTokens();

  assert.equal(calls, 1);
  assert.equal(first.apiToken, 'api-token-1');
  assert.equal(first.licenseToken, 'license-token-1');
  assert.equal(second.apiToken, 'api-token-1');
  assert.equal(second.licenseToken, 'license-token-1');
});

test('deezer media request uses BF_CBC_STRIPE formats like lavasrc', async () => {
  const player = createPlayer({ deezerTrackFormats: ['MP3_128', 'MP3_64'] });
  const originalFetch = global.fetch;
  let capturedMedia: DeezerMediaRequestPayload['media'];

  player._getDeezerSessionTokens = async () => ({
    apiToken: 'api-token',
    licenseToken: 'license-token',
    expiresAtMs: Date.now() + 60_000,
  });
  player._resolveDeezerTrackToken = async () => 'track-token-123';

  global.fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const payload = JSON.parse(String(init.body ?? '{}')) as DeezerMediaRequestPayload;
    capturedMedia = payload.media;
    return jsonResponse({
      data: [{
        media: [{
          cipher: { type: 'BF_CBC_STRIPE' },
          format: 'MP3_128',
          sources: [{ url: 'https://media.example/encrypted-stream' }],
        }],
      }],
    });
  }) as unknown as typeof fetch;

  try {
    const url = await player._resolveDeezerFullStreamUrlWithArl('3135556');

    assert.equal(url, 'https://media.example/encrypted-stream');
    assert.deepEqual(
      capturedMedia?.[0]?.formats,
      [
        { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
        { cipher: 'BF_CBC_STRIPE', format: 'MP3_64' },
      ]
    );
  } finally {
    global.fetch = originalFetch;
  }
});





