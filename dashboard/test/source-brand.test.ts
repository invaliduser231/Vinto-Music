import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasSourceBrand,
  normalizeSourceKey,
  sourceBrandLabel,
} from '../src/lib/source-brand';

test('normalizeSourceKey maps youtube search sources', () => {
  assert.equal(normalizeSourceKey('youtube-search'), 'youtube');
  assert.equal(normalizeSourceKey('spotify-oembed-deezer-search'), 'spotify');
});

test('sourceBrandLabel returns friendly names', () => {
  assert.equal(sourceBrandLabel('deezer'), 'Deezer');
  assert.equal(sourceBrandLabel('soundcloud'), 'SoundCloud');
});

test('hasSourceBrand detects known providers', () => {
  assert.equal(hasSourceBrand('youtube'), true);
  assert.equal(hasSourceBrand('custom-unknown'), false);
});
