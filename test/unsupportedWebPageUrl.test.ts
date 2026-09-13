import test from 'node:test';
import assert from 'node:assert/strict';

import { isWebPageContentType } from '../src/player/musicPlayer/urlResolverMethods.ts';

test('a web page is recognised as such', () => {
  assert.equal(isWebPageContentType('text/html'), true);
  assert.equal(isWebPageContentType('text/html; charset=utf-8'), true);
  assert.equal(isWebPageContentType('application/xhtml+xml'), true);
});

test('audio is never mistaken for a web page', () => {
  for (const type of [
    'audio/mpeg',
    'audio/aacp',
    'audio/ogg',
    'application/ogg',
    'application/octet-stream',
    'audio/x-mpegurl',
  ]) {
    assert.equal(isWebPageContentType(type), false, `${type} must stay playable`);
  }
});

test('a missing content type stays inconclusive so odd stations still work', () => {
  assert.equal(isWebPageContentType(''), false);
  assert.equal(isWebPageContentType(null), false);
  assert.equal(isWebPageContentType(undefined), false);
});
