import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { openSecret, parseEncryptionKey, sealSecret } from '../src/integrations/lastfm/secretBox.ts';
import { ConfigurationError } from '../src/core/errors.ts';

test('sealed secrets round trip through the same key', () => {
  const key = randomBytes(32);
  const sealed = sealSecret('a-last-fm-session-key', key);

  assert.equal(sealed.v, 1);
  assert.notEqual(sealed.data, 'a-last-fm-session-key');
  assert.equal(openSecret(sealed, key), 'a-last-fm-session-key');
});

test('every seal uses a fresh iv', () => {
  const key = randomBytes(32);
  const first = sealSecret('same-input', key);
  const second = sealSecret('same-input', key);

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test('a tampered payload does not decrypt', () => {
  const key = randomBytes(32);
  const sealed = sealSecret('session-key', key);
  const flipped = Buffer.from(sealed.data, 'base64');
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;

  assert.equal(openSecret({ ...sealed, data: flipped.toString('base64') }, key), null);
});

test('a wrong key does not decrypt', () => {
  const sealed = sealSecret('session-key', randomBytes(32));
  assert.equal(openSecret(sealed, randomBytes(32)), null);
});

test('malformed input is rejected instead of throwing', () => {
  const key = randomBytes(32);

  assert.equal(openSecret(null, key), null);
  assert.equal(openSecret({ iv: 'x', tag: 'y', data: 'z' }, key), null);
  assert.equal(openSecret('not-an-object', key), null);
});

test('encryption keys are accepted as hex, base64 and raw bytes', () => {
  const raw = randomBytes(32);

  assert.deepEqual(parseEncryptionKey(raw.toString('hex')), raw);
  assert.deepEqual(parseEncryptionKey(raw.toString('base64')), raw);
  assert.deepEqual(parseEncryptionKey('0123456789abcdef0123456789abcdef'), Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'));
});

test('keys of the wrong length are refused', () => {
  assert.throws(() => parseEncryptionKey('too-short'), ConfigurationError);
  assert.throws(() => parseEncryptionKey(''), ConfigurationError);
});
