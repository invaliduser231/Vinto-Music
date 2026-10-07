import test from 'node:test';
import assert from 'node:assert/strict';

import { asRecord, isRecord, isUnknownArray, readField, readNested } from '../src/utils/unknownData.ts';

test('isRecord accepts objects and arrays but rejects null and primitives', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord('text'), false);
  assert.equal(isRecord(42), false);
});

test('asRecord returns the same object or null', () => {
  const value = { title: 'Song' };
  assert.equal(asRecord(value), value);
  assert.equal(asRecord(null), null);
  assert.equal(asRecord('Song'), null);
});

test('isUnknownArray only accepts arrays', () => {
  assert.equal(isUnknownArray([1, 'two']), true);
  assert.equal(isUnknownArray({ length: 0 }), false);
});

test('readField reads a single key and tolerates non-objects', () => {
  assert.equal(readField({ url: 'https://example.com' }, 'url'), 'https://example.com');
  assert.equal(readField({ url: 'https://example.com' }, 'missing'), undefined);
  assert.equal(readField(null, 'url'), undefined);
  assert.equal(readField('https://example.com', 'length'), undefined);
});

test('readNested walks a path and stops at the first missing segment', () => {
  const payload = { results: { USER: { OPTIONS: { license_token: 'token' } } }, data: [{ id: 7 }] };
  assert.equal(readNested(payload, ['results', 'USER', 'OPTIONS', 'license_token']), 'token');
  assert.equal(readNested(payload, ['data', '0', 'id']), 7);
  assert.equal(readNested(payload, ['results', 'DATA', 'MD5_ORIGIN']), undefined);
  assert.equal(readNested(payload, ['results', 'USER', 'OPTIONS', 'license_token', 'length']), undefined);
  assert.equal(readNested(payload, []), payload);
});
