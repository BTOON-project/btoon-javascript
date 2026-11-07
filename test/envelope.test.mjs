// Compression (SPEC §6) and signed (SPEC §8) envelopes, synchronous and asynchronous, on
// both builds.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';
import { builds, hex } from './helpers.mjs';

const node = builds['esm/node'];
const portable = builds['esm/portable'];
const { BtoonError } = node;

const doc = { rows: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `user${i}`, email: `user${i}@example.com` })) };
const raw = node.encode(doc);

function envelope(algo, payload, usize, { version = 1, reserved = 0, csize = payload.length } = {}) {
  const out = new Uint8Array(16 + payload.length);
  out.set([0x42, 0x54, 0x4f, 0x4e, version, algo]);
  const v = new DataView(out.buffer);
  v.setUint16(6, reserved);
  v.setUint32(8, csize);
  v.setUint32(12, usize);
  out.set(payload, 16);
  return out;
}

function signed(payload, key) {
  const header = Uint8Array.from([0x42, 0x54, 0x53, 0x47, 1, 1, 0, 0]);
  const mac = createHmac('sha256', key).update(header).update(payload).digest();
  const out = new Uint8Array(40 + payload.length);
  out.set(header);
  out.set(mac, 8);
  out.set(payload, 40);
  return out;
}

const isCode = (code) => (e) => {
  assert.ok(e instanceof BtoonError || e?.name === 'BtoonError', `expected BtoonError, got ${e?.stack ?? e}`);
  assert.equal(e.code, code, e.message);
  return true;
};

// Every way to decode: [label, decode function]
const decoders = [
  ['node sync', (b, o) => node.decode(b, o)],
  ['node async', (b, o) => node.decodeAsync(b, o)],
  ['portable sync', (b, o) => portable.decode(b, o)],
  ['portable async', (b, o) => portable.decodeAsync(b, o)],
];

async function rejectsWith(fn, code) {
  let result;
  try {
    result = await fn();
  } catch (e) {
    return isCode(code)(e);
  }
  assert.fail(`expected ${code}, got a value: ${String(result)}`);
}

describe('compression envelope', () => {
  test('zlib round trip on every build and path', async () => {
    const encoders = [
      ['node sync', () => node.encode(doc, { compress: true })],
      ['node async', () => node.encodeAsync(doc, { compress: true })],
      ['portable async', () => portable.encodeAsync(doc, { compress: true })],
      ['portable sync + codec', () => portable.encode(doc, { compress: true, codecs: { zlib: { compress: (d) => zlib.deflateSync(d) } } })],
    ];
    for (const [elabel, encode] of encoders) {
      const packed = await encode();
      assert.equal(hex(packed.subarray(0, 6)), '42544f4e0100', elabel);
      assert.ok(packed.length < raw.length * 0.5, `${elabel}: compressed ${packed.length} vs ${raw.length}`);
      for (const [dlabel, decode] of decoders) {
        assert.deepEqual(await decode(packed), doc, `${elabel} → ${dlabel}`);
      }
    }
  });

  test('brotli and zstd use node:zlib in the Node build', async () => {
    const algos = [['brotli', 3]];
    if (typeof zlib.zstdCompressSync === 'function') algos.push(['zstd', 2]);
    for (const [compression, id] of algos) {
      const packed = node.encode(doc, { compress: true, compression });
      assert.equal(packed[5], id);
      assert.deepEqual(node.decode(packed), doc);
      assert.deepEqual(await node.decodeAsync(packed), doc);
      assert.equal((await node.encodeAsync(doc, { compress: true, compression }))[5], id);
      await rejectsWith(() => portable.decode(packed), 'unsupported_compression');
      const codecs = {
        [compression]: {
          decompress: (d, n) => (compression === 'brotli' ? zlib.brotliDecompressSync : zlib.zstdDecompressSync)(d, { maxOutputLength: n }),
        },
      };
      assert.deepEqual(portable.decode(packed, { codecs }), doc);
    }
  });

  test('Zstandard frames with an oversized window are rejected (SPEC §6)', { skip: typeof zlib.zstdCompressSync !== 'function' }, () => {
    const C = zlib.constants;
    const content = node.encode('small document');
    const frame = new Uint8Array(zlib.zstdCompressSync(content, { params: { [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_contentSizeFlag]: 0 } }));
    assert.equal((frame[4] >> 5) & 1, 0, 'frame has a window descriptor');
    const withWindow = (log) => {
      const f = Uint8Array.from(frame);
      f[5] = (log - 10) << 3;
      return envelope(2, f, content.length);
    };
    assert.equal(node.decode(withWindow(23)), 'small document', '8 MiB window is fine');
    assert.throws(() => node.decode(withWindow(27)), isCode('invalid_envelope'), '128 MiB window for a tiny document');
    assert.equal(node.decode(node.encode(doc, { compress: true, compression: 'zstd' })).rows.length, 50);
  });

  test('small or incompressible documents stay bare (SPEC §6 SHOULDs)', async () => {
    assert.equal(hex(node.encode('hello', { compress: true })), hex(node.encode('hello')));
    const noise = new Uint8Array(randomBytes(4096));
    assert.equal(hex(node.encode(noise, { compress: true })), hex(node.encode(noise)));
    assert.equal(hex(await portable.encodeAsync(noise, { compress: true })), hex(node.encode(noise)));
    // 255 bytes: not compressed; 256 bytes of repetition: compressed.
    const s255 = 'a'.repeat(253);
    assert.equal(node.encode(s255).length, 255);
    assert.equal(node.encode(s255, { compress: true })[0], 0xd9);
    assert.equal(node.encode('a'.repeat(254)).length, 256);
    assert.equal(node.encode('a'.repeat(254), { compress: true })[0], 0x42);
  });

  test('the 5% rule is exact: 20 × envelope_size ≤ 19 × input_size', () => {
    const value = 'q'.repeat(397); // str16 header: 400 bytes
    assert.equal(node.encode(value).length, 400);
    // A codec returning a payload of a chosen size: 16 + 364 = 380 = 0.95 × 400.
    const sized = (n) => ({ zlib: { compress: () => new Uint8Array(n) } });
    assert.equal(node.encode(value, { compress: true, codecs: sized(364) }).length, 380, 'exactly 5% smaller: envelope');
    assert.equal(node.encode(value, { compress: true, codecs: sized(365) }).length, 400, 'less than 5%: bare');
  });

  test('missing codecs raise unsupported_compression, even for small documents', async () => {
    await rejectsWith(() => portable.encode(doc, { compress: true }), 'unsupported_compression');
    await rejectsWith(() => portable.encode(1, { compress: true }), 'unsupported_compression');
    assert.throws(() => portable.encode(doc, { compress: true }), /encodeAsync/);
    for (const compression of ['lz4', 'snappy']) {
      await rejectsWith(() => node.encode(doc, { compress: true, compression }), 'unsupported_compression');
      await rejectsWith(() => node.encodeAsync(doc, { compress: true, compression }), 'unsupported_compression');
      const id = { lz4: 1, snappy: 4 }[compression];
      const fake = envelope(id, new Uint8Array(4), 4);
      for (const [label, decode] of decoders) {
        await rejectsWith(() => decode(fake), 'unsupported_compression').catch((e) => assert.fail(`${label}: ${e}`));
      }
    }
  });

  test('user codecs: precedence, sync/async rules, errors', async () => {
    // A toy "lz4" codec (identity) proves the envelope plumbing; it is not real LZ4.
    const calls = [];
    const identity = {
      compress: (d) => {
        calls.push('c');
        return Uint8Array.from(d.subarray(0, d.length - 100));
      },
      decompress: (d, n) => {
        calls.push(`d${n}`);
        return Uint8Array.from([...d, ...raw.subarray(raw.length - 100)]);
      },
    };
    const packed = node.encode(doc, { compress: true, compression: 'lz4', codecs: { lz4: identity } });
    assert.equal(packed[5], 1);
    assert.deepEqual(node.decode(packed, { codecs: { lz4: identity } }), doc);
    assert.deepEqual(await portable.decodeAsync(packed, { codecs: { lz4: identity } }), doc);
    assert.deepEqual(calls, ['c', `d${raw.length}`, `d${raw.length}`]);
    // A codec overrides the built-in zlib.
    let used = false;
    const z = { compress: (d) => ((used = true), zlib.deflateSync(d, { level: 1 })) };
    node.encode(doc, { compress: true, codecs: { zlib: z } });
    assert.ok(used);
    // Async codecs work in the async API only.
    const asyncCodec = { compress: async (d) => zlib.deflateSync(d), decompress: async (d, n) => zlib.inflateSync(d, { maxOutputLength: n }) };
    await rejectsWith(() => portable.encode(doc, { compress: true, codecs: { zlib: asyncCodec } }), 'invalid_argument');
    const viaAsync = await portable.encodeAsync(doc, { compress: true, codecs: { zlib: asyncCodec } });
    assert.deepEqual(await portable.decodeAsync(viaAsync, { codecs: { zlib: asyncCodec } }), doc);
    await rejectsWith(() => portable.decode(viaAsync, { codecs: { zlib: asyncCodec } }), 'invalid_argument');
    // Failures.
    const throwing = { decompress: () => { throw new Error('boom'); }, compress: () => { throw new Error('boom'); } };
    await rejectsWith(() => node.decode(viaAsync, { codecs: { zlib: throwing } }), 'invalid_envelope');
    await rejectsWith(() => node.decodeAsync(viaAsync, { codecs: { zlib: throwing } }), 'invalid_envelope');
    await rejectsWith(() => node.encode(doc, { compress: true, codecs: { zlib: throwing } }), 'invalid_argument');
    const wrongType = { decompress: () => 'nope', compress: () => [1, 2] };
    await rejectsWith(() => node.decode(viaAsync, { codecs: { zlib: wrongType } }), 'invalid_argument');
    await rejectsWith(() => node.encode(doc, { compress: true, codecs: { zlib: wrongType } }), 'invalid_argument');
    const tooShort = { decompress: (d, n) => new Uint8Array(n - 1) };
    await rejectsWith(() => node.decode(viaAsync, { codecs: { zlib: tooShort } }), 'invalid_envelope');
  });

  test('envelope header checks happen before decompression', async () => {
    const z = zlib.deflateSync(raw);
    const cases = [
      [envelope(0, z, raw.length, { version: 2 }), 'invalid_envelope'],
      [envelope(0, z, raw.length, { reserved: 1 }), 'invalid_envelope'],
      [envelope(0, z, raw.length, { csize: z.length + 1 }), 'invalid_envelope'],
      [envelope(0, z, raw.length, { csize: z.length - 1 }), 'invalid_envelope'],
      [envelope(0, z, 256 * 1024 * 1024 + 1), 'size_limit'],
      [envelope(9, z, raw.length), 'unsupported_compression'],
      [envelope(0, z, raw.length + 1), 'invalid_envelope'],
      [envelope(0, z, raw.length - 1), 'invalid_envelope'],
      [envelope(0, Uint8Array.from([...z, 0, 1, 2]), raw.length), 'invalid_envelope'], // trailing junk
      [envelope(0, Uint8Array.from([0x78, 0x9c, ...new Uint8Array(10)]), raw.length), 'invalid_envelope'],
      [envelope(0, new Uint8Array(0), 0), 'invalid_envelope'],
      [envelope(0, z.subarray(0, z.length - 5), raw.length), 'invalid_envelope'],
    ];
    for (const [bytes, code] of cases) {
      for (const [label, decode] of decoders) {
        await rejectsWith(() => decode(bytes), code).catch((e) => assert.fail(`${label} ${hex(bytes.subarray(0, 16))}: ${e.message}`));
      }
    }
    for (const [label, decode] of decoders) {
      await rejectsWith(() => decode(envelope(0, z, raw.length), { autoDecompress: false }), 'invalid_envelope');
      await rejectsWith(() => decode(envelope(0, z, raw.length), { maxDecompressedSize: raw.length - 1 }), 'size_limit');
      assert.deepEqual(await decode(envelope(0, z, raw.length), { maxDecompressedSize: raw.length }), doc, label);
      // Fewer than 16 bytes: not an envelope, so "B" is the integer 66 followed by junk.
      await rejectsWith(() => decode(Uint8Array.from([0x42, 0x54, 0x4f, 0x4e, 1, 0, 0, 0])), 'trailing_data');
      // An empty zlib stream decompresses to an empty (truncated) document.
      await rejectsWith(() => decode(envelope(0, zlib.deflateSync(new Uint8Array(0)), 0)), 'truncated');
    }
  });

  test('decompression bombs are capped while decompressing', async () => {
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const bomb = zlib.deflateSync(zeros, { level: 9 });
    assert.ok(bomb.length < 100 * 1024);
    // Declared honestly: rejected by the limit before decompressing.
    const honest = envelope(0, bomb, zeros.length);
    for (const [, decode] of decoders) await rejectsWith(() => decode(honest, { maxDecompressedSize: 1024 * 1024 }), 'size_limit');
    // Declared small: decompression stops at the declared size.
    const liar = envelope(0, bomb, 1024 * 1024);
    for (const [label, decode] of decoders) {
      const t0 = performance.now();
      await rejectsWith(() => decode(liar), 'invalid_envelope');
      assert.ok(performance.now() - t0 < 5000, `${label} took too long`);
    }
    // Declared large but backed by a tiny stream: no huge allocation, just a size mismatch.
    const tiny = envelope(0, zlib.deflateSync(new Uint8Array(100)), 200 * 1024 * 1024);
    for (const [, decode] of decoders) await rejectsWith(() => decode(tiny), 'invalid_envelope');
    // A real 64 MiB document under the default 256 MiB limit decodes.
    const big = node.encode(zeros, { compress: true });
    assert.ok(big.length < 200 * 1024);
    for (const [label, decode] of decoders) {
      const out = await decode(big);
      assert.equal(out.length, zeros.length, label);
    }
  });
});

describe('signed envelope', () => {
  const key = new TextEncoder().encode('k'.repeat(32));

  test('sign and verify on every path; bytes are identical everywhere', async () => {
    const value = { a: 1, b: [true, null], s: 'x'.repeat(300) };
    const outputs = [
      node.encode(value, { hmacKey: key }),
      portable.encode(value, { hmacKey: key }),
      await node.encodeAsync(value, { hmacKey: key }),
      await portable.encodeAsync(value, { hmacKey: key }),
      node.encode(value, { hmacKey: 'k'.repeat(32) }),
    ].map(hex);
    assert.equal(new Set(outputs).size, 1, 'pure-JS, node:crypto and WebCrypto HMACs agree');
    const sealed = node.encode(value, { hmacKey: key });
    assert.equal(hex(sealed.subarray(0, 8)), '4254534701010000');
    assert.equal(hex(sealed), hex(signed(node.encode(value), key)));
    for (const [label, decode] of decoders) {
      assert.deepEqual(await decode(sealed, { hmacKey: key }), value, label);
      assert.deepEqual(await decode(sealed, { hmacKey: 'k'.repeat(32) }), value, label);
      await rejectsWith(() => decode(sealed), 'authentication_failed');
      await rejectsWith(() => decode(sealed, { hmacKey: 'wrong-key' }), 'authentication_failed');
      await rejectsWith(() => decode(node.encode(value), { hmacKey: key }), 'authentication_failed');
    }
  });

  test('long keys (> 64 bytes) and binary keys', async () => {
    for (const k of [new Uint8Array(randomBytes(100)), new Uint8Array(randomBytes(1)), new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(65))]) {
      const a = node.encode('v', { hmacKey: k });
      assert.equal(hex(portable.encode('v', { hmacKey: k })), hex(a));
      assert.equal(hex(await portable.encodeAsync('v', { hmacKey: k })), hex(a));
      assert.equal(hex(a), hex(signed(node.encode('v'), k)));
    }
  });

  test('every tampered byte is rejected, before the payload is parsed', async () => {
    const sealed = node.encode({ data: 'x'.repeat(50) }, { hmacKey: key });
    for (let i = 0; i < sealed.length; i++) {
      const t = Uint8Array.from(sealed);
      t[i] ^= 0x01;
      for (const [label, decode] of decoders) {
        try {
          await decode(t, { hmacKey: key });
          assert.fail(`${label}: tampered byte ${i} accepted`);
        } catch (e) {
          assert.ok(e instanceof BtoonError || e?.name === 'BtoonError', String(e));
          assert.ok(['authentication_failed', 'invalid_envelope'].includes(e.code), `${label} byte ${i}: ${e.code}`);
        }
      }
    }
    // A forged envelope around garbage fails authentication, not parsing.
    const forged = signed(Uint8Array.of(0xc1), new TextEncoder().encode('attacker'));
    for (const [, decode] of decoders) await rejectsWith(() => decode(forged, { hmacKey: key }), 'authentication_failed');
    // A genuinely signed garbage payload is verified, then fails to parse.
    for (const [, decode] of decoders) await rejectsWith(() => decode(signed(Uint8Array.of(0xc1), key), { hmacKey: key }), 'invalid_marker');
  });

  test('malformed signed envelopes', async () => {
    const sealed = signed(node.encode(1), key);
    for (const [, decode] of decoders) {
      await rejectsWith(() => decode(sealed.subarray(0, 39), { hmacKey: key }), 'invalid_envelope');
      const v2 = Uint8Array.from(sealed);
      v2[4] = 2;
      await rejectsWith(() => decode(v2, { hmacKey: key }), 'invalid_envelope');
      // Short "BTSG…" input without a key is not an envelope: integer 66 + trailing bytes.
      await rejectsWith(() => decode(sealed.subarray(0, 39)), 'trailing_data');
    }
  });

  test('layering is sign(compress(encode(value)))', async () => {
    const sealed = node.encode(doc, { compress: true, hmacKey: key });
    assert.equal(hex(sealed.subarray(0, 4)), '42545347');
    assert.equal(hex(sealed.subarray(40, 44)), '42544f4e');
    const asyncSealed = await portable.encodeAsync(doc, { compress: true, hmacKey: key });
    assert.equal(hex(asyncSealed.subarray(40, 44)), '42544f4e');
    for (const [label, decode] of decoders) {
      assert.deepEqual(await decode(sealed, { hmacKey: key }), doc, label);
      assert.deepEqual(await decode(asyncSealed, { hmacKey: key }), doc, label);
      // Tampering with the compressed payload is caught by the MAC, before inflating.
      const t = Uint8Array.from(sealed);
      t[t.length - 10] ^= 0xff;
      await rejectsWith(() => decode(t, { hmacKey: key }), 'authentication_failed');
    }
  });
});

describe('async specifics', () => {
  test('decodeAsync works on a private copy of its input', async () => {
    const bytes = node.encode({ v: 'original', n: [1, 2, 3] }, { compress: false, hmacKey: 'secret' });
    const p = portable.decodeAsync(bytes, { hmacKey: 'secret' });
    bytes.fill(0);
    assert.deepEqual(await p, { v: 'original', n: [1, 2, 3] });
  });

  test('errors are rejections, never synchronous throws', async () => {
    let p;
    assert.doesNotThrow(() => {
      p = portable.decodeAsync('not bytes');
    });
    await assert.rejects(p, isCode('invalid_argument'));
    assert.doesNotThrow(() => {
      p = portable.encodeAsync(() => 1);
    });
    await assert.rejects(p, isCode('invalid_argument'));
    await assert.rejects(node.decodeAsync(Uint8Array.of(0xc1)), isCode('invalid_marker'));
  });
});
