import test from 'node:test';
import assert from 'node:assert/strict';

import { isNodeLinkSourceIdentifier, parseSearchPrefix } from '../src/player/musicPlayer/searchPrefix.ts';

test('parseSearchPrefix maps short and long aliases to NodeLink identifiers', () => {
  assert.deepEqual(parseSearchPrefix('sc: lofi beats'), { identifier: 'scsearch', label: 'SoundCloud', query: 'lofi beats' });
  assert.deepEqual(parseSearchPrefix('Deezer:Alleine'), { identifier: 'dzsearch', label: 'Deezer', query: 'Alleine' });
  assert.equal(parseSearchPrefix('ytm:song')?.identifier, 'ytmsearch');
  assert.equal(parseSearchPrefix('apple: song')?.identifier, 'amsearch');
});

test('parseSearchPrefix ignores unknown prefixes, urls and empty queries', () => {
  assert.equal(parseSearchPrefix('Lecrae: Blessings'), null);
  assert.equal(parseSearchPrefix('https://example.com/a'), null);
  assert.equal(parseSearchPrefix('sc:   '), null);
  assert.equal(parseSearchPrefix('just a song'), null);
});

test('isNodeLinkSourceIdentifier only accepts real source identifiers', () => {
  assert.equal(isNodeLinkSourceIdentifier('ytsearch:song'), true);
  assert.equal(isNodeLinkSourceIdentifier('dzisrc:USRC17607839'), true);
  assert.equal(isNodeLinkSourceIdentifier('sprec:seed_tracks=1'), true);
  assert.equal(isNodeLinkSourceIdentifier('ftts:hello'), true);
  assert.equal(isNodeLinkSourceIdentifier('Lecrae: Blessings'), false);
  assert.equal(isNodeLinkSourceIdentifier('intro:song'), false);
});
