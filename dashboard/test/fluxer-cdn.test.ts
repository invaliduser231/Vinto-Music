import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuildIconUrl, rebaseFluxerCdnUrl } from '../src/lib/fluxer-cdn';

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

test('rebaseFluxerCdnUrl moves default cdn urls to a self-hosted base', () => {
  const url = rebaseFluxerCdnUrl('https://fluxerusercontent.com/avatars/1/hash.png', 'https://chat.example.com/media/');
  assert.equal(url, 'https://chat.example.com/media/avatars/1/hash.png');
});

test('rebaseFluxerCdnUrl leaves other urls alone', () => {
  const url = 'https://cdn.example.com/avatars/1/hash.png';
  assert.equal(rebaseFluxerCdnUrl(url, 'https://chat.example.com/media'), url);
  assert.equal(rebaseFluxerCdnUrl('https://fluxerusercontent.com/a.png', 'https://fluxerusercontent.com'), 'https://fluxerusercontent.com/a.png');
});
