// Input in shared memory (review 2026-11-13: SharedArrayBuffer input in browsers failed as
// invalid_utf8 or size_limit). Browsers' TextDecoder refuses views of a SharedArrayBuffer, as
// WebIDL requires; Node.js's accepts them. This process installs a TextDecoder that refuses
// them like Chrome's before loading the library (node:test runs each file in its own process).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

const NativeTextDecoder = globalThis.TextDecoder;
const isShared = (v) => {
  const buffer = ArrayBuffer.isView(v) ? v.buffer : v;
  return Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]';
};
class BrowserTextDecoder extends NativeTextDecoder {
  decode(input, options) {
    if (input !== undefined && isShared(input)) {
      throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.");
    }
    return super.decode(input, options);
  }
}
globalThis.TextDecoder = BrowserTextDecoder;

const { builds, hex } = await import('./helpers.mjs');

// Long non-ASCII strings, keys and column names: they go through TextDecoder.
const value = {
  greeting: 'Grüße, 世界! '.repeat(4),
  ['schlüssel-'.repeat(4)]: 'value',
  rows: Array.from({ length: 8 }, (_, i) => ({ ['naïve column name '.repeat(2)]: i, ['ünïcödé '.repeat(5)]: `zeile ${i} `.repeat(5) })),
};

function shared(bytes) {
  const sab = new SharedArrayBuffer(bytes.length + 3);
  const view = new Uint8Array(sab, 3, bytes.length);
  view.set(bytes);
  return view;
}

test('the stand-in TextDecoder refuses shared views, as browsers do', () => {
  assert.throws(() => new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(4))), TypeError);
  assert.equal(new TextDecoder().decode(new Uint8Array([0x68, 0x69])), 'hi');
});

for (const [name, lib] of Object.entries(builds)) {
  test(`${name}: decode and decodeAsync accept input in a SharedArrayBuffer`, async () => {
    const bytes = lib.encode(value);
    const view = shared(bytes);
    assert.deepEqual(lib.decode(view), value);
    assert.deepEqual(lib.decode(view, { strict: false }), value);
    assert.deepEqual(lib.decode(new DataView(view.buffer, 3, bytes.length)), value);
    const whole = new SharedArrayBuffer(bytes.length);
    new Uint8Array(whole).set(bytes);
    assert.deepEqual(lib.decode(whole), value);
    assert.deepEqual(await lib.decodeAsync(view), value);
    // Signed and compressed documents too.
    const key = 'k'.repeat(32);
    const sealed = shared(lib.encode(value, { hmacKey: key }));
    assert.deepEqual(lib.decode(sealed, { hmacKey: key }), value);
    assert.deepEqual(await lib.decodeAsync(sealed, { hmacKey: key }), value);
    const packed = lib.encode(value, { compress: true, codecs: { zlib: { compress: (d) => new Uint8Array(zlib.deflateSync(d)) } } });
    assert.equal(hex(packed.subarray(0, 4)), '42544f4e');
    assert.deepEqual(lib.decode(shared(packed)), value);
    // Decoding never reads the shared memory again: what comes back doesn't change with it.
    const out = lib.decode(view);
    view.fill(0);
    assert.deepEqual(out, value);
  });
}
