// The pure-JS SHA-256 / HMAC-SHA256 (src/sha256.ts): FIPS 180-4 and RFC 4231 test vectors,
// then a differential test against node:crypto.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { hmacSha256, sha256, timingSafeEqual } from '../dist/esm/sha256.js';
import { hex, rng, unhex } from './helpers.mjs';

const utf8 = (s) => new TextEncoder().encode(s);

test('SHA-256 test vectors (FIPS 180-4 examples)', () => {
  assert.equal(hex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(hex(sha256(new Uint8Array(1000000).fill(0x61))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('HMAC-SHA256 test vectors (RFC 4231)', () => {
  const cases = [
    ['0b'.repeat(20), utf8('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [hex(utf8('Jefe')), utf8('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['aa'.repeat(20), unhex('dd'.repeat(50)), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    ['0102030405060708090a0b0c0d0e0f10111213141516171819', unhex('cd'.repeat(50)), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
    ['aa'.repeat(131), utf8('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    [
      'aa'.repeat(131),
      utf8('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    ],
  ];
  for (const [key, data, mac] of cases) assert.equal(hex(hmacSha256(unhex(key), [data])), mac);
  // Test case 5 is truncated to 128 bits.
  assert.equal(hex(hmacSha256(unhex('0c'.repeat(20)), [utf8('Test With Truncation')])).slice(0, 32), 'a3b6167473100ee06e0c796c2955552b');
});

test('matches node:crypto on random keys, messages and part splits', () => {
  const r = rng(256);
  const lengths = [0, 1, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096];
  for (let i = 0; i < 1500; i++) {
    const msg = new Uint8Array(randomBytes(i < lengths.length * 4 ? lengths[i % lengths.length] : r.int(700)));
    const key = new Uint8Array(randomBytes(r.pick([1, 16, 32, 63, 64, 65, 100, 200])));
    assert.equal(hex(sha256(msg)), createHash('sha256').update(msg).digest('hex'));
    const cut1 = r.int(msg.length + 1);
    const cut2 = cut1 + r.int(msg.length - cut1 + 1);
    const parts = [msg.subarray(0, cut1), msg.subarray(cut1, cut2), msg.subarray(cut2)];
    assert.equal(hex(hmacSha256(key, parts)), createHmac('sha256', key).update(msg).digest('hex'));
  }
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2)), false);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
});
