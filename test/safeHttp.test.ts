import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnsafeUrlError,
  assertPublicHttpUrl,
  isBlockedAddress,
  safeFetch,
  setPrivateUrlPolicy,
} from '../src/utils/safeHttp.ts';

test('isBlockedAddress flags private, loopback and link-local ranges', () => {
  for (const address of ['127.0.0.1', '10.0.1.175', '172.20.0.5', '192.168.1.10', '169.254.169.254', '100.64.1.1', '0.0.0.0']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['::1', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1', '::ffff:7f00:1', '::']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '65.109.123.29', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('assertPublicHttpUrl rejects local targets and non-http schemes', async () => {
  setPrivateUrlPolicy({ allowPrivate: false });
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1:9092/api'), UnsafeUrlError);
  await assert.rejects(assertPublicHttpUrl('http://[::1]/'), UnsafeUrlError);
  await assert.rejects(assertPublicHttpUrl('http://localhost:2333/v4/info'), UnsafeUrlError);
  await assert.rejects(assertPublicHttpUrl('http://mongo.internal/'), UnsafeUrlError);
  await assert.rejects(assertPublicHttpUrl('file:///etc/passwd'), UnsafeUrlError);
  await assert.rejects(assertPublicHttpUrl('https://user:pass@example.com/'), UnsafeUrlError);
  await assert.doesNotReject(assertPublicHttpUrl('https://93.184.215.14/stream.mp3'));
});

test('assertPublicHttpUrl allows private targets when the operator opts in', async () => {
  setPrivateUrlPolicy({ allowPrivate: true });
  try {
    await assert.doesNotReject(assertPublicHttpUrl('http://192.168.1.20:8000/radio'));
    await assert.rejects(assertPublicHttpUrl('ftp://192.168.1.20/radio'), UnsafeUrlError);
  } finally {
    setPrivateUrlPolicy({ allowPrivate: false });
  }
});

test('safeFetch refuses to connect to a loopback address', async () => {
  setPrivateUrlPolicy({ allowPrivate: false });
  await assert.rejects(safeFetch('http://127.0.0.1:1/'), UnsafeUrlError);
});
