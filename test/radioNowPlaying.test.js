import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRadioNowPlaying } from '../src/bot/commands/helpers/radioNowPlaying.js';

function createReadableStreamFromChunks(chunks) {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      if (!queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(queue.shift());
    },
  });
}

function createResponse({ ok = true, headers = {}, body = null, json = null }) {
  return {
    ok,
    headers: {
      get(name) {
        return headers[String(name ?? '').toLowerCase()] ?? null;
      },
    },
    body,
    async json() {
      return typeof json === 'function' ? json() : json;
    },
  };
}

test('detectRadioNowPlaying prefers ICY metadata when available', async () => {
  const originalFetch = global.fetch;
  const metaint = 5;
  const metadataText = "StreamTitle='Artist Demo - Song Demo';";
  const metadataBytes = new Uint8Array(48);
  metadataBytes.set(Buffer.from(metadataText, 'utf8'));
  const chunk = new Uint8Array([
    ...Buffer.from('abcde', 'utf8'),
    3,
    ...metadataBytes,
  ]);

  global.fetch = async () => createResponse({
    headers: {
      'icy-metaint': String(metaint),
    },
    body: createReadableStreamFromChunks([chunk]),
  });

  try {
    const detected = await detectRadioNowPlaying({
      url: 'https://radio.example/icy',
      auddApiToken: null,
      logger: null,
    });
    assert.deepEqual(detected, {
      artist: 'Artist Demo',
      title: 'Song Demo',
      source: 'icy',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('detectRadioNowPlaying falls back to AudD when no ICY metadata exists', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === 'https://radio.example/raw') {
      return createResponse({
        headers: {},
        body: createReadableStreamFromChunks([new Uint8Array(70 * 1024)]),
      });
    }

    if (url === 'https://api.audd.io/') {
      return createResponse({
        json: {
          status: 'success',
          result: {
            artist: 'Recognized Artist',
            title: 'Recognized Track',
          },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const detected = await detectRadioNowPlaying({
      url: 'https://radio.example/raw',
      auddApiToken: 'demo-token',
      logger: null,
    });
    assert.deepEqual(detected, {
      artist: 'Recognized Artist',
      title: 'Recognized Track',
      source: 'audd',
    });
    assert.deepEqual(calls, [
      'https://radio.example/raw',
      'https://radio.example/raw',
      'https://api.audd.io/',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
