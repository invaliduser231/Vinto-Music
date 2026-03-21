import test from 'node:test';
import assert from 'node:assert/strict';

import { LyricsService } from '../src/bot/services/lyricsService.ts';

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

test('lyrics service prefers best lrclib match instead of first hit', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    { trackName: 'Pazifik', artistName: 'Wrong Artist', plainLyrics: 'wrong lyrics' },
    { trackName: 'Pazifik', artistName: 'Nina Chuba', plainLyrics: 'correct lyrics' },
  ]) as Response;

  try {
    const result = await service.search('Nina Chuba - Pazifik');
    assert.ok(result);
    assert.equal(result.source, 'lrclib.net');
    assert.equal(result.lyrics, 'correct lyrics');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lyrics service can still resolve title-only query with lrclib ranking', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    { trackName: 'Pazifik (Remix)', artistName: 'Wrong Artist', plainLyrics: 'wrong remix lyrics' },
    { trackName: 'Pazifik', artistName: 'Nina Chuba', plainLyrics: 'correct original lyrics' },
  ]) as Response;

  try {
    const result = await service.search('Pazifik');
    assert.ok(result);
    assert.equal(result.source, 'lrclib.net');
    assert.equal(result.lyrics, 'correct original lyrics');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lyrics service falls back to lyrics.ovh when lrclib has no match', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });
  const calls: string[] = [];

  global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('lrclib.net/api/search')) {
      return jsonResponse([]);
    }
    if (target.includes('api.lyrics.ovh')) {
      return jsonResponse({ lyrics: 'lyrics from ovh' });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  };

  try {
    const result = await service.search('Nina Chuba - Pazifik');
    assert.ok(result);
    assert.equal(result.source, 'lyrics.ovh');
    assert.equal(result.lyrics, 'lyrics from ovh');
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});





