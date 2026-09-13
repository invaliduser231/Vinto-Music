import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeLinkClient } from '../src/player/musicPlayer/NodeLinkClient.ts';

function client(overrides: Record<string, unknown> = {}) {
  return new NodeLinkClient({
    baseUrl: 'http://nodelink:3000',
    password: 'secret',
    requestTimeoutMs: 8_000,
    linkTimeoutMs: 30_000,
    ...overrides,
  } as never);
}

test('a pasted link gets the long budget, a playlist needs it', () => {
  const c = client();
  assert.equal(
    c.timeoutForIdentifier('https://open.spotify.com/playlist/37i9dQZF1E8KXWVetEWEKv'),
    30_000,
  );
});

test('a mirror search keeps the short budget so the chain stays bounded', () => {
  const c = client();
  assert.equal(c.timeoutForIdentifier('dzsearch:Amy Winehouse - Rehab'), 8_000);
  assert.equal(c.timeoutForIdentifier('ytsearch:Some Song'), 8_000);
});

test('a plain search term is a search, not a link', () => {
  assert.equal(client().timeoutForIdentifier('just a song title'), 8_000);
});

test('a link never gets less time than a search, even if misconfigured', () => {
  const c = client({ requestTimeoutMs: 20_000, linkTimeoutMs: 5_000 });
  assert.equal(c.timeoutForIdentifier('https://open.spotify.com/album/x'), 20_000);
});

test('http and uppercase schemes count as links too', () => {
  const c = client();
  assert.equal(c.timeoutForIdentifier('http://example.com/x'), 30_000);
  assert.equal(c.timeoutForIdentifier('HTTPS://open.spotify.com/x'), 30_000);
});

test('the link budget defaults to 30s when unset', () => {
  const c = new NodeLinkClient({
    baseUrl: 'http://nodelink:3000',
    requestTimeoutMs: 8_000,
  } as never);
  assert.equal(c.timeoutForIdentifier('https://open.spotify.com/x'), 30_000);
});
