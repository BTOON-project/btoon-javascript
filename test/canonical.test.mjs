// Canonical encoding (SPEC §4): random values are encoded identically by the library and by
// an independent reference encoder, decode back to the same value, and re-encode to the
// same bytes. Plus exact checks of the tabular size rule and type codes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builds, hex, rng } from './helpers.mjs';
import { refEncode } from './reference.mjs';

const ITERATIONS = Number(process.env.CANONICAL_ITERATIONS ?? 1500);

const KEY_PARTS = ['a', 'b', 'Z', 'id', 'name', 'é', '日', '', '�', '😀', '\u{10000}', '', 'zz', '__proto__', 'constructor'];

function genString(r, maxLen = 12) {
  const alphabet = ['a', 'z', ' ', '\u0000', 'é', 'ß', '日', '本', '﻿', '', '￿', '🎉', '😀', '\u{10FFFF}', 'x'];
  const n = r.int(maxLen + 1);
  let s = '';
  for (let i = 0; i < n; i++) s += r.pick(alphabet);
  if (r.bool(0.05)) s += 'L'.repeat(r.int(400));
  return s;
}

function genKey(r) {
  let k = r.pick(KEY_PARTS);
  if (r.bool(0.5)) k += r.pick(KEY_PARTS);
  return k;
}

function genScalar(r, lib) {
  switch (r.int(16)) {
    case 0:
      return null;
    case 1:
      return r.bool();
    case 2:
      return r.int(300) - 150;
    case 3:
      return (r.int(2) ? 1 : -1) * Math.floor(r.next() * 2 ** (r.int(53) + 1));
    case 4:
      return r.pick([0, -0, 1.5, -2.25, Math.PI, 1e300, -1e-300, 5e-324, Infinity, -Infinity, NaN, 2 ** 53, -(2 ** 60), 0.1]);
    case 5:
      return r.next() * 1e6 - 5e5;
    case 6: {
      const bits = BigInt(r.int(130));
      const v = (1n << bits) + BigInt(r.int(1000));
      return r.bool() ? v : -v;
    }
    case 7:
      return genString(r);
    case 8:
      return Uint8Array.from({ length: r.int(20) }, () => r.int(256));
    case 9:
      return Float32Array.from({ length: r.int(6) }, () => Math.fround(r.next() * 100 - 50));
    case 10:
      return Float64Array.from({ length: r.int(6) }, () => r.next() * 1e10 - 5e9);
    case 11:
      return new Date(Math.floor((r.next() - 0.5) * 1e14));
    case 12: {
      const seconds = BigInt(Math.floor((r.next() - 0.3) * 2 ** r.int(40)));
      return new lib.Timestamp(seconds, r.bool() ? 0 : r.int(1e9), r.bool(0.2) ? r.int(2161) - 1080 : undefined);
    }
    case 13:
      return new lib.Ext(r.pick([0, 1, 42, 127, -7, -100, -128]), Uint8Array.from({ length: r.pick([0, 1, 2, 3, 4, 8, 16, 17, 300]) }, () => r.int(256)));
    case 14:
      return undefined;
    default:
      return r.pick(['', 'a', 0, 1, 255, 65536, -1]);
  }
}

function genValue(r, lib, depth = 0) {
  const k = depth >= 4 ? 0 : r.int(10);
  if (k < 5) return genScalar(r, lib);
  if (k < 7) return Array.from({ length: r.int(depth === 0 ? 20 : 8) }, () => genValue(r, lib, depth + 1));
  if (k < 9) {
    const o = {};
    for (let i = r.int(10); i > 0; i--) {
      Object.defineProperty(o, genKey(r), { value: genValue(r, lib, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return r.bool(0.15) ? new Map(Object.entries(o)) : o;
  }
  // A table: uniform rows, sometimes broken on purpose.
  const keys = [...new Set(Array.from({ length: 1 + r.int(4) }, () => genKey(r)))];
  const rows = Array.from({ length: r.int(14) }, () => {
    const row = {};
    for (const key of keys) {
      Object.defineProperty(row, key, { value: genValue(r, lib, depth + 2), enumerable: true, writable: true, configurable: true });
    }
    return row;
  });
  if (rows.length > 2 && r.bool(0.15)) delete rows[rows.length - 1][keys[0]];
  if (rows.length > 2 && r.bool(0.1)) rows[1] = new Map(Object.entries(rows[1]));
  return rows;
}

for (const name of ['esm/node', 'esm/portable']) {
  const lib = builds[name];
  test(`${name}: random values match the reference encoder and round-trip (${ITERATIONS} values)`, () => {
    const r = rng(0xb7001);
    let tabular = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const v = genValue(r, lib);
      const autoTabular = !r.bool(0.1);
      const bytes = lib.encode(v, { autoTabular });
      const ref = refEncode(v, { autoTabular });
      assert.equal(hex(bytes), hex(ref), `value #${i} differs from the reference encoding`);
      if (hex(bytes).includes('f6000000010000')) tabular++;
      // Exact decode (timestamps as objects), then re-encode: same bytes.
      const back = lib.decode(bytes, { timestamps: 'object' });
      assert.equal(hex(lib.encode(back, { autoTabular })), hex(bytes), `value #${i} does not re-encode identically`);
      // The async path produces the same bytes.
    }
    assert.ok(tabular > ITERATIONS / 20, `only ${tabular} values used the tabular encoding`);
  });
}

test('tabular size rule boundary is exact (SPEC §5.6.2)', () => {
  const { encode } = builds['esm/node'];
  const strhdr = (l) => (l <= 31 ? 1 : l <= 0xff ? 2 : 3);
  for (const keyLens of [[1], [2], [1, 1], [5, 3], [31], [32], [40, 2, 7], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]) {
    const keys = keyLens.map((l, i) => String.fromCharCode(97 + i).repeat(l));
    const perRow = (keys.length <= 15 ? 1 : 3) + keyLens.reduce((a, l) => a + strhdr(l) + l, 0);
    const overhead = 18 + keyLens.reduce((a, l) => a + 9 + l, 0);
    for (let n = 2; n <= 30; n++) {
      const rows = Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k) => [k, i])));
      const isTabular = (b) => b[0] >= 0xc7 && b[0] <= 0xc9 && b[b[0] === 0xc7 ? 2 : b[0] === 0xc8 ? 3 : 5] === 0xf6;
      assert.equal(isTabular(encode(rows)), n * perRow > overhead, `keys ${keyLens} rows ${n}`);
      assert.equal(isTabular(encode(rows, { autoTabular: false })), false);
    }
  }
  // One 2-byte key: 7 rows stay plain, 8 rows become tabular (the vectors' example).
  assert.equal(encode(Array(7).fill({ ab: 1 }))[0], 0x97);
  assert.equal(encode(Array(8).fill({ ab: 1 }))[0], 0xc7);
});

test('tabular qualification: same key sets, non-empty, all maps', () => {
  const { encode } = builds['esm/node'];
  const many = (f) => Array.from({ length: 20 }, (_, i) => f(i));
  assert.equal(encode(many((i) => ({ a: i, b: i })))[0], 0xc7);
  assert.equal(encode(many((i) => (i % 2 ? { a: i, b: i } : { b: i, a: i })))[0], 0xc7, 'key order does not matter');
  assert.equal(encode(many((i) => (i === 7 ? { a: i } : { a: i, b: i })))[0], 0xdc, 'different key set → plain');
  assert.equal(encode(many((i) => (i === 7 ? { a: i, c: i } : { a: i, b: i })))[0], 0xdc, 'same size, different keys');
  assert.equal(encode(many(() => ({})))[0], 0xdc, 'no columns → plain');
  assert.equal(encode(many((i) => (i === 3 ? [i] : { a: i })))[0], 0xdc, 'a non-map element → plain');
  assert.equal(encode(many((i) => (i % 2 ? new Map([['a', i]]) : { a: i })))[0], 0xc7, 'Maps and objects mix');
  assert.equal(encode([{ a: 1 }])[0], 0x91, 'one row is never tabular');
  // Nested tables and tables inside maps.
  const nested = many((g) => ({ g, rows: Array.from({ length: 6 }, (_, i) => ({ n: i, sq: i * i })) }));
  const back = builds['esm/node'].decode(encode(nested));
  assert.deepEqual(back, nested);
});

test('tabular type codes describe the first row (SPEC §5.6.1)', () => {
  const lib = builds['esm/node'];
  class Str {
    toJSON() {
      return 'resolved';
    }
  }
  const cases = [
    [null, 0], [undefined, 0], [true, 1], [-5, 2], [2 ** 40, 2], [2n ** 63n - 1n, 2], [2n ** 63n, 3],
    [2n ** 64n, 9], [1.5, 4], [-0, 4], [NaN, 4], ['x', 5], [new Uint8Array(1), 6], [new ArrayBuffer(1), 6],
    [new DataView(new ArrayBuffer(1)), 6], [[1], 7], [{ a: 1 }, 8], [new Map([['a', 1]]), 8], [new Date(0), 9],
    [new lib.Timestamp(0n, 0), 9], [new lib.Ext(1, new Uint8Array(1)), 9], [new Float32Array(1), 9], [new Str(), 5],
    [Array.from({ length: 10 }, (_, i) => ({ n: i })), 7], // a cell that is itself tabular
    [new lib.Ext(-10, lib.encode(Array.from({ length: 10 }, (_, i) => ({ n: i }))).subarray(3)), 7], // raw tabular Ext
    [new lib.Ext(-4, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0)), 9],
    [Object(5), 2], [new (class { constructor() { this.a = 1; } })(), 8],
  ];
  for (const [value, code] of cases) {
    const rows = Array.from({ length: 12 }, () => ({ k: value }));
    const b = lib.encode(rows);
    const h = b[0] === 0xc7 ? 3 : b[0] === 0xc8 ? 4 : 6;
    assert.equal(b[h - 1], 0xf6, `tabular for ${String(value)}`);
    // payload: version(4) cols(4) rows(4) name_len(4) "k"(1) → type code at payload offset 17
    assert.equal(b[h + 17], code, `type code of ${Object.prototype.toString.call(value)} ${String(value)}`);
  }
});

test('encodeAsync produces the same canonical bytes', async () => {
  const lib = builds['esm/portable'];
  const r = rng(99);
  for (let i = 0; i < 200; i++) {
    const v = genValue(r, lib);
    assert.equal(hex(await lib.encodeAsync(v)), hex(lib.encode(v)));
  }
});
