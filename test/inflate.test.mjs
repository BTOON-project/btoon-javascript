// The pure-JS zlib decoder (src/inflate.ts) against node:zlib: same output for every valid
// stream, and the same accept/reject verdict for hand-crafted edge cases and for mutated
// streams.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { adler32, inflateZlib } from '../dist/esm/inflate.js';
import { BtoonError } from '../dist/esm/index.js';
import { hex, rng } from './helpers.mjs';

const MUTATIONS = Number(process.env.INFLATE_MUTATIONS ?? 30000);

/** node:zlib's verdict: the output, or null if it rejects (incl. trailing bytes, over limit). */
function reference(data, limit) {
  try {
    const r = zlib.inflateSync(data, { info: true, maxOutputLength: Math.max(1, limit) });
    if (r.engine.bytesWritten !== data.length) return null;
    if (r.buffer.length > limit) return null;
    return new Uint8Array(r.buffer);
  } catch {
    return null;
  }
}

function ours(data, limit) {
  try {
    return inflateZlib(data, limit);
  } catch (e) {
    assert.ok(e instanceof BtoonError, `non-BtoonError from inflate: ${e?.stack ?? e}`);
    assert.equal(e.code, 'invalid_envelope');
    return null;
  }
}

function agree(data, limit, label) {
  const want = reference(data, limit);
  const got = ours(data, limit);
  if (want === null) assert.equal(got, null, `${label}: node:zlib rejects but inflateZlib accepts ${hex(data.subarray(0, 64))}`);
  else {
    assert.notEqual(got, null, `${label}: node:zlib accepts but inflateZlib rejects ${hex(data.subarray(0, 64))}`);
    assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(want)), 0, `${label}: outputs differ`);
  }
  return want !== null;
}

function corpus() {
  const r = rng(1);
  const text = 'The quick brown fox jumps over the lazy dog. BTOON tabular rows: id,name,email\n';
  const words = Array.from({ length: 3000 }, () => r.pick(['alpha', 'beta', 'gamma', 'delta', '{"id":', '42', ',', '\n']));
  return [
    new Uint8Array(0),
    Uint8Array.of(0),
    Uint8Array.of(0xff),
    new TextEncoder().encode(text),
    new TextEncoder().encode(text.repeat(400)),
    new TextEncoder().encode(words.join('')),
    new Uint8Array(randomBytes(3000)),
    new Uint8Array(70000), // runs of zeros, longer than a stored block
    Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff),
    Uint8Array.from({ length: 20000 }, () => r.int(4)), // small alphabet
    new Uint8Array(randomBytes(200000)),
    new TextEncoder().encode('ab'.repeat(40000) + 'x'.repeat(300) + text.repeat(50)),
  ];
}

test('valid streams: every level, strategy and window size', () => {
  const strategies = [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE, zlib.constants.Z_FIXED];
  let streams = 0;
  for (const raw of corpus()) {
    for (const level of [0, 1, 2, 6, 9]) {
      for (const strategy of strategies) {
        for (const windowBits of [9, 12, 15]) {
          const z = zlib.deflateSync(raw, { level, strategy, windowBits, memLevel: windowBits === 9 ? 1 : 8 });
          const out = inflateZlib(z, raw.length);
          assert.equal(Buffer.compare(Buffer.from(out), Buffer.from(raw)), 0, `level ${level} strategy ${strategy} wb ${windowBits}`);
          streams++;
        }
      }
    }
  }
  assert.ok(streams > 800);
});

test('output is capped at the declared size and must match it', () => {
  const raw = new Uint8Array(100000);
  const z = zlib.deflateSync(raw);
  assert.equal(inflateZlib(z, raw.length).length, raw.length);
  assert.throws(() => inflateZlib(z, raw.length - 1), /more than the declared size/);
  assert.equal(inflateZlib(z, raw.length + 10).length, raw.length, 'the caller checks for a shorter output');
  assert.throws(() => inflateZlib(Uint8Array.from([...z, 0]), raw.length), /trailing bytes/);
  assert.throws(() => inflateZlib(z.subarray(0, z.length - 1), raw.length), /truncated/);
  assert.equal(adler32(new Uint8Array(0)), 1);
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
  const big = new Uint8Array(randomBytes(1 << 20));
  const zb = zlib.deflateSync(big);
  assert.equal(adler32(big), new DataView(zb.buffer, zb.byteOffset + zb.length - 4).getUint32(0));
});

// --- hand-crafted streams for zlib's code-validity rules ------------------------------------

class Bits {
  bytes = [];
  acc = 0;
  n = 0;
  put(value, count) {
    for (let i = 0; i < count; i++) {
      this.acc |= ((value >> i) & 1) << this.n;
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  /** A Huffman code is sent most-significant bit first. */
  code(code, len) {
    for (let i = len - 1; i >= 0; i--) this.put((code >> i) & 1, 1);
  }
  end() {
    if (this.n) this.bytes.push(this.acc);
    return Uint8Array.from(this.bytes);
  }
}

function canonical(lengths) {
  const codes = new Array(lengths.length).fill(-1);
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] === len) codes[s] = code++;
    }
    code <<= 1;
  }
  return codes;
}

/**
 * One final dynamic block: `lit` and `dist` code lengths, then `symbols` (literal/length
 * symbols with optional extra bits, and distance symbols), wrapped in a zlib stream whose
 * Adler-32 is computed over `expected` (or zero).
 */
function dynamicBlock(lit, dist, emit, expected = new Uint8Array(0), clOverride) {
  const b = new Bits();
  b.put(1, 1);
  b.put(2, 2);
  b.put(lit.length - 257, 5);
  b.put(dist.length - 1, 5);
  b.put(19 - 4, 4);
  // Code-length code: symbols 0..15 with 4-bit codes (complete), 16..18 unused.
  const cl = clOverride ?? Array.from({ length: 19 }, (_, s) => (s < 16 ? 4 : 0));
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  for (const s of order) b.put(cl[s], 3);
  const clCodes = canonical(cl);
  for (const len of [...lit, ...dist]) b.code(clCodes[len], cl[len]);
  const litCodes = canonical(lit);
  const distCodes = canonical(dist);
  emit({
    lit: (s) => b.code(litCodes[s], lit[s]),
    dist: (s) => b.code(distCodes[s], dist[s]),
    bits: (v, n) => b.put(v, n),
  });
  const body = b.end();
  const a = adler32(expected);
  return Uint8Array.from([0x78, 0x01, ...body, a >>> 24, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]);
}

test('hand-crafted streams: same verdict as zlib for incomplete/over-subscribed codes', () => {
  const lens = (n, entries) => {
    const a = new Array(n).fill(0);
    for (const [s, l] of entries) a[s] = l;
    return a;
  };
  const cases = [];
  // 'A' (65) with a 1-bit code, end-of-block with a 1-bit code: complete.
  cases.push(['complete 2-symbol code', dynamicBlock(lens(257, [[65, 1], [256, 1]]), [1, 1], (e) => { e.lit(65); e.lit(256); }, Uint8Array.of(65)), true]);
  // Only end-of-block, with a single 1-bit code: incomplete but allowed (max length 1).
  cases.push(['single 1-bit lit/len code', dynamicBlock(lens(257, [[256, 1]]), [0], (e) => e.lit(256)), true]);
  // Incomplete with a longer code: rejected.
  cases.push(['incomplete lit/len code (len 2)', dynamicBlock(lens(257, [[65, 2], [256, 2]]), [0], (e) => { e.lit(65); e.lit(256); }, Uint8Array.of(65)), false]);
  // Over-subscribed lit/len code.
  cases.push(['over-subscribed lit/len', dynamicBlock(lens(257, [[65, 1], [66, 1], [256, 1]]), [0], (e) => e.lit(256)), false]);
  // Missing end-of-block code.
  cases.push(['no end-of-block code', dynamicBlock(lens(257, [[65, 1], [66, 1]]), [0], (e) => e.lit(65), Uint8Array.of(65)), false]);
  // A single 1-bit distance code is allowed; use it: "AB" + copy(len 3, dist 2) → "ABABA".
  const lit3 = lens(258, [[65, 2], [66, 2], [256, 2], [257, 2]]);
  cases.push(['single distance code, used', dynamicBlock(lit3, [0, 1], (e) => { e.lit(65); e.lit(66); e.lit(257); e.dist(1); e.lit(256); }, new TextEncoder().encode('ABABA')), true]);
  // Distance tree with no codes at all: fine if unused, an error if a match needs it.
  cases.push(['empty distance tree, unused', dynamicBlock(lens(257, [[65, 1], [256, 1]]), [0], (e) => { e.lit(65); e.lit(256); }, Uint8Array.of(65)), true]);
  cases.push(['empty distance tree, used', dynamicBlock(lit3, [0], (e) => { e.lit(65); e.lit(66); e.lit(257); e.bits(0, 1); e.lit(256); }), false]);
  // Incomplete distance code with max length 2: rejected.
  cases.push(['incomplete distance code (len 2)', dynamicBlock(lit3, [2, 2], (e) => e.lit(256)), false]);
  // Distance too far back.
  cases.push(['distance too far back', dynamicBlock(lit3, [1, 1], (e) => { e.lit(65); e.lit(257); e.dist(1); e.lit(256); }), false]);
  // Incomplete code-length code.
  const badCl = Array.from({ length: 19 }, (_, s) => (s < 15 ? 4 : 0));
  cases.push(['incomplete code-length code', dynamicBlock(lens(257, [[256, 1]]), [0], (e) => e.lit(256), new Uint8Array(0), badCl), false]);
  // More than 30 distance codes (HDIST=31) is rejected even if unused.
  cases.push(['31 distance codes', dynamicBlock(lens(257, [[65, 1], [256, 1]]), new Array(31).fill(0), (e) => e.lit(256)), false]);
  // Fixed Huffman: length symbol 286 and distance code 30 are invalid.
  const fixed = (emit) => {
    const b = new Bits();
    b.put(1, 1);
    b.put(1, 2);
    emit(b);
    return Uint8Array.from([0x78, 0x01, ...b.end(), 0, 0, 0, 1]);
  };
  cases.push(['fixed: only end-of-block', fixed((b) => b.code(0, 7)), true]);
  cases.push(['fixed: length symbol 286', fixed((b) => b.code(0xc6, 8)), false]);
  cases.push(['fixed: distance code 30', fixed((b) => { b.code(0x30 + 65, 8); b.code(1, 7); b.code(30, 5); b.code(0, 7); }), false]);
  // Stored blocks.
  cases.push(['stored: empty final block', Uint8Array.of(0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0, 0, 0, 1), true]);
  cases.push(['stored: bad NLEN', Uint8Array.of(0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xfe, 0, 0, 0, 1), false]);
  cases.push(['block type 3', Uint8Array.of(0x78, 0x01, 0x07, 0, 0, 0, 1), false]);
  cases.push(['preset dictionary flag', Uint8Array.of(0x78, 0xbb, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 1), false]);
  cases.push(['bad header checksum', Uint8Array.of(0x78, 0x02, 0x03, 0, 0, 0, 0, 1), false]);
  cases.push(['window size 2^16', Uint8Array.of(0x88, 0x1c, 0x03, 0, 0, 0, 0, 1), false]);
  cases.push(['method 15', Uint8Array.of(0x7f, 0x07, 0x03, 0, 0, 0, 0, 1), false]);
  cases.push(['wrong Adler-32', Uint8Array.of(0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x02), false]);
  for (const [label, data, valid] of cases) {
    assert.equal(agree(data, 1000, label), valid, `${label}: node:zlib verdict`);
  }
});

test(`mutated streams: identical verdicts to node:zlib (${MUTATIONS} mutations)`, () => {
  const r = rng(0x1f1a7e);
  const seeds = [];
  for (const raw of corpus().filter((c) => c.length < 30000)) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY]) {
        seeds.push({ raw, z: new Uint8Array(zlib.deflateSync(raw, { level, strategy })) });
      }
    }
  }
  let accepted = 0;
  for (let i = 0; i < MUTATIONS; i++) {
    const { raw, z } = r.pick(seeds);
    const m = Array.from(z);
    for (let k = 1 + r.int(3); k > 0; k--) {
      const p = r.int(m.length + 1);
      switch (r.int(6)) {
        case 0:
        case 1:
          if (m.length) m[p % m.length] ^= 1 << r.int(8);
          break;
        case 2:
          if (m.length) m[p % m.length] = r.int(256);
          break;
        case 3:
          m.splice(p, 1);
          break;
        case 4:
          m.splice(p, 0, r.int(256));
          break;
        default:
          m.length = Math.min(m.length, p);
      }
    }
    const data = Uint8Array.from(m);
    const limit = r.bool() ? raw.length : raw.length * 2 + 100;
    if (agree(data, limit, `mutation ${i}`)) accepted++;
  }
  // Random garbage behind a valid header exercises the block parser.
  for (let i = 0; i < 2000; i++) {
    const data = Uint8Array.from([0x78, 0x9c, ...randomBytes(r.int(64))]);
    agree(data, 4096, `garbage ${i}`);
  }
  assert.ok(accepted > 0, 'some mutations should still be valid streams');
});
