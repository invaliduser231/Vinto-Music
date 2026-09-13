import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldMirrorFailedStartup } from '../src/player/musicPlayer/resolverMethods.ts';

const YT = 'https://www.youtube.com/watch?v=2gE789IPa-w';

test('a youtube link the user asked for is never swapped for another recording', () => {
  assert.equal(
    shouldMirrorFailedStartup({ url: YT, source: 'youtube', previousMirrorSources: [] }),
    false,
  );
});

test('a youtube track that is itself a mirror may keep looking', () => {
  assert.equal(
    shouldMirrorFailedStartup({ url: YT, source: 'youtube', previousMirrorSources: ['spotify'] }),
    true,
  );
});

test('an ordinary source still mirrors as before', () => {
  assert.equal(
    shouldMirrorFailedStartup({
      url: 'https://open.spotify.com/track/abc',
      source: 'spotify',
      previousMirrorSources: [],
    }),
    true,
  );
});

test('live streams, radio and raw urls are never mirrored', () => {
  assert.equal(shouldMirrorFailedStartup({ url: YT, source: 'youtube', isLive: true }), false);
  assert.equal(shouldMirrorFailedStartup({ url: 'https://x/y.mp3', source: 'radio-stream' }), false);
  assert.equal(shouldMirrorFailedStartup({ url: 'https://x/y.mp3', source: 'http-audio' }), false);
  assert.equal(shouldMirrorFailedStartup({ url: 'https://x/y.mp3', source: 'url' }), false);
});

test('a live youtube stream stays excluded even when it is a mirror', () => {
  assert.equal(
    shouldMirrorFailedStartup({
      url: YT,
      source: 'youtube',
      isLive: true,
      previousMirrorSources: ['spotify'],
    }),
    false,
  );
});

test('missing fields do not throw and default to mirroring', () => {
  assert.equal(shouldMirrorFailedStartup({}), true);
  assert.equal(shouldMirrorFailedStartup({ url: null, source: null }), true);
});

test('youtu.be short links count as requested youtube links too', () => {
  assert.equal(
    shouldMirrorFailedStartup({ url: 'https://youtu.be/2gE789IPa-w', source: 'youtube' }),
    false,
  );
});
