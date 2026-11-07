// The async API without Compression Streams or WebCrypto (as on Node.js 18, or on an
// insecure http:// page where crypto.subtle is missing): it falls back to the synchronous
// implementations. node:test runs each file in its own process, so removing globals here
// does not affect other tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

for (const name of ['CompressionStream', 'DecompressionStream']) delete globalThis[name];
try {
  delete globalThis.crypto;
} catch {
  // not configurable
}
if (globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

const node = await import('../dist/esm/node.js');
const portable = await import('../dist/esm/index.js');

const doc = { rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `user${i}` })) };
const isCode = (code) => (e) => e instanceof node.BtoonError || e?.name === 'BtoonError' ? e.code === code : false;

test('web APIs are really gone in this process', () => {
  assert.equal(typeof globalThis.CompressionStream, 'undefined');
  assert.equal(typeof globalThis.DecompressionStream, 'undefined');
  assert.equal(globalThis.crypto?.subtle, undefined);
});

test('compression falls back to the synchronous implementations', async () => {
  const packed = await node.encodeAsync(doc, { compress: true });
  assert.equal(packed[0], 0x42);
  assert.deepEqual(await node.decodeAsync(packed), doc);
  assert.deepEqual(await portable.decodeAsync(packed), doc, 'pure-JS inflate');
  await assert.rejects(portable.encodeAsync(doc, { compress: true }), isCode('unsupported_compression'));
  const codecs = { zlib: { compress: (d) => zlib.deflateSync(d) } };
  assert.deepEqual(portable.decode(await portable.encodeAsync(doc, { compress: true, codecs })), doc);
  // The output cap still applies on the fallback path.
  const bomb = zlib.deflateSync(new Uint8Array(1 << 22));
  const liar = new Uint8Array(16 + bomb.length);
  liar.set([0x42, 0x54, 0x4f, 0x4e, 1, 0, 0, 0]);
  new DataView(liar.buffer).setUint32(8, bomb.length);
  new DataView(liar.buffer).setUint32(12, 1000);
  liar.set(bomb, 16);
  await assert.rejects(portable.decodeAsync(liar), isCode('invalid_envelope'));
  await assert.rejects(node.decodeAsync(liar), isCode('invalid_envelope'));
});

test('HMAC falls back to pure JS / node:crypto with identical bytes', async () => {
  const key = 'fallback-key';
  const expected = node.encode(doc, { hmacKey: key });
  assert.deepEqual(await portable.encodeAsync(doc, { hmacKey: key }), expected);
  assert.deepEqual(await node.encodeAsync(doc, { hmacKey: key }), expected);
  assert.deepEqual(await portable.decodeAsync(expected, { hmacKey: key }), doc);
  await assert.rejects(portable.decodeAsync(expected, { hmacKey: 'other' }), isCode('authentication_failed'));
});
