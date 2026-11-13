// Seeded mutation fuzzing of the decoder: for any input, decode either returns a value or
// throws a BtoonError — never another exception, never a hang. Values that decode in strict
// mode re-encode canonically, and that encoding is a fixed point.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builds, hex, loadVectors, rng, unhex } from './helpers.mjs';

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 100000);
const ASYNC_ITERATIONS = Number(process.env.FUZZ_ASYNC_ITERATIONS ?? 3000);
const SEED = Number(process.env.FUZZ_SEED ?? 0x5eed);
const KEY = new TextEncoder().encode('fuzz-key-0123456789abcdef0123456');

function seeds(lib) {
  const out = loadVectors().vectors.filter((v) => v.hex !== undefined).map((v) => unhex(v.hex));
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    name: `user${i}`,
    tags: [i, -i, `t${i}`],
    score: i * 1.25,
    big: 2n ** 70n + BigInt(i),
    when: new Date(1700000000000 + i),
    blob: Uint8Array.of(i, 255 - i),
    vec: new Float32Array([i, -i]),
    nested: Array.from({ length: 4 }, (_, j) => ({ j, sq: j * j })),
  }));
  const doc = {
    rows,
    ts: new lib.Timestamp(-62135596800n, 123456789, 60),
    ext: new lib.Ext(7, Uint8Array.of(9, 9, 9)),
    f64: new Float64Array([0.1, NaN, -0]),
    text: 'Grüße, 世界! 🚀'.repeat(3),
    deep: [[[[[[1]]]]]],
  };
  out.push(lib.encode(doc), lib.encode(rows), lib.encode(doc, { autoTabular: false }));
  out.push(builds['esm/node'].encode(doc, { compress: true }), lib.encode(doc, { hmacKey: KEY }));
  out.push(builds['esm/node'].encode(rows, { compress: true, hmacKey: KEY }));
  return out;
}

const INTERESTING = [0x00, 0x01, 0x7f, 0x80, 0xff, 0xc0, 0xc1, 0xc7, 0xc9, 0xcf, 0xd3, 0xd7, 0xdb, 0xdd, 0xdf, 0xf6, 0xfc, 0xfb];

function mutate(r, data, pool) {
  const m = Array.from(data);
  for (let k = 1 + r.int(4); k > 0; k--) {
    const p = r.int(m.length + 1);
    switch (r.int(9)) {
      case 0:
        if (m.length) m[p % m.length] ^= 1 << r.int(8);
        break;
      case 1:
        if (m.length) m[p % m.length] = r.int(256);
        break;
      case 2:
        if (m.length) m[p % m.length] = r.pick(INTERESTING);
        break;
      case 3:
        m.splice(p, 1 + r.int(4));
        break;
      case 4:
        m.splice(p, 0, ...Array.from({ length: 1 + r.int(4) }, () => r.int(256)));
        break;
      case 5:
        m.length = Math.min(m.length, p);
        break;
      case 6: {
        // Big-endian length fields: try extreme values.
        const v = r.pick([0xff, 0x7f, 0x00, 0x80]);
        for (let i = 0; i < 4 && p + i < m.length; i++) m[p + i] = v;
        break;
      }
      case 7: {
        // Splice in a chunk of another seed.
        const other = r.pick(pool);
        const a = r.int(other.length + 1);
        m.splice(p, r.int(8), ...other.subarray(a, a + r.int(24)));
        break;
      }
      default:
        if (m.length > 1) {
          const q = r.int(m.length);
          [m[p % m.length], m[q]] = [m[q], m[p % m.length]];
        }
    }
  }
  return Uint8Array.from(m);
}

function randomOptions(r) {
  const o = {};
  if (r.bool(0.2)) o.strict = false;
  if (r.bool(0.2)) o.maxDepth = r.int(10);
  if (r.bool(0.3)) o.timestamps = 'object';
  if (r.bool(0.2)) o.bigint = 'always';
  if (r.bool(0.1)) o.hmacKey = KEY;
  if (r.bool(0.1)) o.maxDecompressedSize = r.int(5000);
  if (r.bool(0.1)) o.maxValues = r.int(60);
  if (r.bool(0.05)) o.autoDecompress = false;
  return o;
}

for (const name of ['esm/node', 'esm/portable']) {
  const lib = builds[name];
  test(`${name}: decode never throws anything but BtoonError (${ITERATIONS} mutated inputs, seed ${SEED})`, (t) => {
    const r = rng(SEED);
    const pool = seeds(lib);
    const codes = new Map();
    let decoded = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const input = mutate(r, r.pick(pool), pool);
      const opts = randomOptions(r);
      let value;
      try {
        value = lib.decode(input, opts);
      } catch (e) {
        if (!(e instanceof lib.BtoonError)) {
          assert.fail(`iteration ${i}: ${e?.stack ?? e}\ninput ${hex(input)}\noptions ${JSON.stringify(opts, (_, v) => (v instanceof Uint8Array ? hex(v) : v))}`);
        }
        codes.set(e.code, (codes.get(e.code) ?? 0) + 1);
        continue;
      }
      decoded++;
      if (opts.strict === false || opts.timestamps !== 'object') continue;
      // Canonical re-encoding is a fixed point.
      let once;
      try {
        once = lib.encode(value, { maxDepth: 1000 });
      } catch (e) {
        assert.fail(`iteration ${i}: decoded value does not re-encode: ${e?.stack ?? e}\ninput ${hex(input)}`);
      }
      const twice = lib.encode(lib.decode(once, { timestamps: 'object', maxDepth: 1000 }), { maxDepth: 1000 });
      assert.equal(hex(twice), hex(once), `iteration ${i}: re-encoding is not stable\ninput ${hex(input)}`);
    }
    t.diagnostic(`${decoded} decoded, errors: ${JSON.stringify(Object.fromEntries([...codes].sort((a, b) => b[1] - a[1])))}`);
    assert.ok(decoded > ITERATIONS / 50, 'mutations should not all be rejected');
  });

  test(`${name}: decodeAsync rejects only with BtoonError (${ASYNC_ITERATIONS} mutated inputs)`, async () => {
    const r = rng(SEED + 1);
    const pool = seeds(lib);
    for (let i = 0; i < ASYNC_ITERATIONS; i++) {
      const input = mutate(r, r.pick(pool), pool);
      const opts = randomOptions(r);
      try {
        await lib.decodeAsync(input, opts);
      } catch (e) {
        if (!(e instanceof lib.BtoonError)) assert.fail(`iteration ${i}: ${e?.stack ?? e}\ninput ${hex(input)}`);
      }
    }
  });
}

test('random byte strings', () => {
  const r = rng(SEED + 2);
  const lib = builds['esm/portable'];
  for (let i = 0; i < ITERATIONS / 5; i++) {
    const input = Uint8Array.from({ length: r.int(64) }, () => r.int(256));
    try {
      lib.decode(input, randomOptions(r));
    } catch (e) {
      if (!(e instanceof lib.BtoonError)) assert.fail(`${e?.stack ?? e}\ninput ${hex(input)}`);
    }
  }
});

test('every truncation of a valid document is rejected', () => {
  for (const name of ['esm/node', 'esm/portable']) {
    const lib = builds[name];
    for (const full of seeds(lib).slice(-6)) {
      const opts = { hmacKey: full[2] === 0x53 ? KEY : undefined };
      for (let n = 0; n < full.length; n++) {
        if (n === 1 && full[0] === 0x42 && opts.hmacKey === undefined) {
          // The first byte of an envelope ("B") is, on its own, the valid document 66.
          assert.equal(lib.decode(full.subarray(0, 1)), 66);
          continue;
        }
        assert.throws(() => lib.decode(full.subarray(0, n), opts), lib.BtoonError, `${name}: prefix ${n}/${full.length}`);
      }
    }
  }
});
