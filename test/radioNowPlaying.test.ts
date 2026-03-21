import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  __setRadioNowPlayingSpawnForTests,
  detectRadioNowPlaying,
} from '../src/bot/commands/helpers/radioNowPlaying.ts';

type RadioResponseInit = {
  ok?: boolean;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  json?: unknown;
};

type FakeSpawnedProcess = EventEmitter & {
  stdout: PassThrough;
  kill: () => void;
};

function createReadableStreamFromChunks(chunks: Uint8Array[]) {
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

function createResponse({ ok = true, headers = {}, body = null, json = null }: RadioResponseInit): Response {
  return {
    ok,
    headers: {
      get(name: string) {
        return headers[String(name ?? '').toLowerCase()] ?? null;
      },
    },
    body,
    async json() {
      return typeof json === 'function' ? json() : json;
    },
  } as unknown as Response;
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

  global.fetch = (async () => createResponse({
    headers: {
      'icy-metaint': String(metaint),
    },
    body: createReadableStreamFromChunks([chunk]),
  })) as typeof fetch;

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
  const calls: string[] = [];

  global.fetch = (async (input) => {
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
  }) as typeof fetch;

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

test('detectRadioNowPlaying uses ffmpeg audio sampling for hls urls before AudD fallback', async () => {
  const originalFetch = global.fetch;

  global.fetch = (async (input) => {
    const url = String(input);
    if (url === 'https://radio.example/live.m3u8') {
      return createResponse({
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
        },
        body: createReadableStreamFromChunks([new Uint8Array(Buffer.from('#EXTM3U\n'))]),
      });
    }
    if (url === 'https://api.audd.io/') {
      return createResponse({
        json: {
          status: 'success',
          result: {
            artist: 'HLS Artist',
            title: 'HLS Track',
          },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  __setRadioNowPlayingSpawnForTests(() => {
    const proc = new EventEmitter() as FakeSpawnedProcess;
    proc.stdout = new PassThrough();
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.stdout.write(Buffer.alloc(70 * 1024));
      proc.stdout.end();
      proc.emit('close', 0, null);
    });
    return proc;
  });

  try {
    const detected = await detectRadioNowPlaying({
      url: 'https://radio.example/live.m3u8',
      auddApiToken: 'demo-token',
      logger: null,
    });
    assert.deepEqual(detected, {
      artist: 'HLS Artist',
      title: 'HLS Track',
      source: 'audd',
    });
  } finally {
    global.fetch = originalFetch;
    __setRadioNowPlayingSpawnForTests(null);
  }
});





