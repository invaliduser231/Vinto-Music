import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuildIconUrl } from '../src/lib/fluxer-cdn';

test('buildGuildIconUrl builds static guild icon CDN url', () => {
  const url = buildGuildIconUrl('123', 'abcdef', { cdnBase: 'https://fluxerusercontent.com' });
  assert.equal(url, 'https://fluxerusercontent.com/icons/123/abcdef.png');
});

test('buildGuildIconUrl uses gif for animated icon hashes', () => {
  const url = buildGuildIconUrl('123', 'a_abcdef', { cdnBase: 'https://fluxerusercontent.com' });
  assert.equal(url, 'https://fluxerusercontent.com/icons/123/a_abcdef.gif');
});

test('buildGuildIconUrl returns null without icon hash', () => {
  assert.equal(buildGuildIconUrl('123', null), null);
  assert.equal(buildGuildIconUrl('123', ''), null);
});
