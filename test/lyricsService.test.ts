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






test('lyrics service passes synced lyrics through when lrclib has them', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    {
      trackName: 'Chaos',
      artistName: 'Provinz',
      plainLyrics: 'Zeile eins\nZeile zwei',
      syncedLyrics: '[00:12.30]Zeile eins\n[00:18.90]Zeile zwei',
    },
  ]) as Response;

  try {
    const result = await service.search('Provinz - Chaos');
    assert.equal(result?.source, 'lrclib.net');
    assert.equal(result?.lyrics, 'Zeile eins\nZeile zwei');
    assert.match(String(result?.syncedLyrics), /\[00:12\.30\]Zeile eins/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('lyrics service reports no synced lyrics when lrclib only has plain text', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    { trackName: 'Nur ein bisschen', artistName: 'Mayberg', plainLyrics: 'Ich glaub, du kennst das' },
  ]) as Response;

  try {
    const result = await service.search('Mayberg - Nur ein bisschen');
    assert.equal(result?.lyrics, 'Ich glaub, du kennst das');
    assert.equal(result?.syncedLyrics, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('lyrics service prefers a timed candidate over an equally good plain one', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    { trackName: 'Chaos', artistName: 'Provinz', plainLyrics: 'nur text' },
    {
      trackName: 'Chaos',
      artistName: 'Provinz',
      plainLyrics: 'mit timing',
      syncedLyrics: '[00:01.00]mit timing',
    },
  ]) as Response;

  try {
    const result = await service.search('Provinz - Chaos');
    assert.equal(result?.lyrics, 'mit timing');
    assert.match(String(result?.syncedLyrics), /\[00:01\.00\]/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a timed but badly matching candidate does not pass the quality gate', async () => {
  const originalFetch = global.fetch;
  const service = new LyricsService({ debug() {} });

  global.fetch = async () => jsonResponse([
    {
      trackName: 'Voellig anderer Song',
      artistName: 'Fremder Interpret',
      plainLyrics: 'falscher text',
      syncedLyrics: '[00:01.00]falscher text',
    },
  ]) as Response;

  try {
    const result = await service.search('Provinz - Chaos');
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
});
