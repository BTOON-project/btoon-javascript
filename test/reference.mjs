// A deliberately simple, slow canonical encoder written straight from SPEC §3–§5 (in the
// style of btoon-core's tests/vectors/generate.py). The property tests compare the
// library's optimized encoder against it on random values.

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s);
const cmpBytes = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const sortKeys = (keys) => [...keys].sort((a, b) => cmpBytes(utf8(a), utf8(b)));

const cat = (...parts) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

function be(bytes, value) {
  // Unsigned big-endian of a (non-negative) bigint in `bytes` bytes.
  const out = [];
  for (let i = bytes - 1; i >= 0; i--) out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
}

function twos(bytes, value) {
  return be(bytes, value < 0n ? (1n << BigInt(8 * bytes)) + value : value);
}

function intBytes(v) {
  if (v >= 0n) {
    if (v <= 0x7fn) return [Number(v)];
    if (v <= 0xffn) return [0xcc, ...be(1, v)];
    if (v <= 0xffffn) return [0xcd, ...be(2, v)];
    if (v <= 0xffffffffn) return [0xce, ...be(4, v)];
    if (v <= 0xffffffffffffffffn) return [0xcf, ...be(8, v)];
  } else {
    if (v >= -32n) return twos(1, v);
    if (v >= -128n) return [0xd0, ...twos(1, v)];
    if (v >= -32768n) return [0xd1, ...twos(2, v)];
    if (v >= -(2n ** 31n)) return [0xd2, ...twos(4, v)];
    if (v >= -(2n ** 63n)) return [0xd3, ...twos(8, v)];
  }
  // bigint (§5.4): minimal two's complement.
  let n = 1;
  while (!(v >= -(1n << BigInt(8 * n - 1)) && v < 1n << BigInt(8 * n - 1))) n++;
  return [...ext(-4, Uint8Array.from(twos(n, v)))];
}

function ext(type, payload) {
  const t = type & 0xff;
  const n = payload.length;
  const fixed = { 1: 0xd4, 2: 0xd5, 4: 0xd6, 8: 0xd7, 16: 0xd8 }[n];
  if (fixed) return cat([fixed, t], payload);
  if (n <= 0xff) return cat([0xc7, n, t], payload);
  if (n <= 0xffff) return cat([0xc8, ...be(2, BigInt(n)), t], payload);
  return cat([0xc9, ...be(4, BigInt(n)), t], payload);
}

function str(s) {
  const b = utf8(s);
  const n = b.length;
  if (n <= 31) return cat([0xa0 | n], b);
  if (n <= 0xff) return cat([0xd9, n], b);
  if (n <= 0xffff) return cat([0xda, ...be(2, BigInt(n))], b);
  return cat([0xdb, ...be(4, BigInt(n))], b);
}

function bin(b) {
  const n = b.length;
  if (n <= 0xff) return cat([0xc4, n], b);
  if (n <= 0xffff) return cat([0xc5, ...be(2, BigInt(n))], b);
  return cat([0xc6, ...be(4, BigInt(n))], b);
}

function hdr(n, fix, b16, b32) {
  if (n <= 15) return [fix | n];
  if (n <= 0xffff) return [b16, ...be(2, BigInt(n))];
  return [b32, ...be(4, BigInt(n))];
}

function timestamp(seconds, nanos, offset) {
  if (offset !== undefined) {
    return ext(-1, Uint8Array.from([...be(4, BigInt(nanos)), ...twos(8, seconds), ...twos(2, BigInt(offset))]));
  }
  if (seconds >> 34n === 0n) {
    const data64 = (BigInt(nanos) << 34n) | seconds;
    if (data64 >> 32n === 0n) return ext(-1, Uint8Array.from(be(4, data64)));
    return ext(-1, Uint8Array.from(be(8, data64)));
  }
  return ext(-1, Uint8Array.from([...be(4, BigInt(nanos)), ...twos(8, seconds)]));
}

const isPlain = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const isMapLike = (v) => isPlain(v) || v instanceof Map;
const entriesOf = (v) => (v instanceof Map ? [...v.entries()] : Object.keys(v).map((k) => [k, v[k]]));

function typeCode(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? 2 : 4;
  if (typeof v === 'bigint') return v >= -(2n ** 63n) && v < 2n ** 63n ? 2 : v >= 2n ** 63n && v < 2n ** 64n ? 3 : 9;
  if (typeof v === 'string') return 5;
  if (v instanceof Float32Array || v instanceof Float64Array) return 9;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return 6;
  if (Array.isArray(v)) return 7;
  if (isMapLike(v)) return 8;
  if (v.constructor?.name === 'Ext' && v.type === -10) return 7;
  return 9;
}

export function refEncode(v, opts = {}) {
  const tabular = opts.autoTabular ?? true;
  if (v === null || v === undefined) return Uint8Array.of(0xc0);
  switch (typeof v) {
    case 'boolean':
      return Uint8Array.of(v ? 0xc3 : 0xc2);
    case 'bigint':
      return Uint8Array.from(intBytes(v));
    case 'number': {
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) return Uint8Array.from(intBytes(BigInt(v)));
      const out = new Uint8Array(9);
      out[0] = 0xcb;
      if (Number.isNaN(v)) out.set([0x7f, 0xf8], 1);
      else new DataView(out.buffer).setFloat64(1, v);
      return out;
    }
    case 'string':
      return str(v);
  }
  if (v instanceof Float32Array || v instanceof Float64Array) {
    return ext(v instanceof Float32Array ? -5 : -6, new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
  }
  if (v instanceof Uint8Array) return bin(v);
  if (v instanceof Date) {
    const ms = BigInt(v.getTime());
    let s = ms / 1000n;
    let r = ms % 1000n;
    if (r < 0n) {
      r += 1000n;
      s -= 1n;
    }
    return timestamp(s, Number(r) * 1e6);
  }
  if (v.constructor?.name === 'Timestamp') return timestamp(v.seconds, v.nanoseconds, v.offsetMinutes);
  if (v.constructor?.name === 'Ext') return ext(v.type, v.data);
  if (Array.isArray(v)) {
    if (tabular && v.length >= 2 && v.every(isMapLike)) {
      const keys = sortKeys(entriesOf(v[0]).map(([k]) => k));
      const same = v.every((row) => {
        const k = sortKeys(entriesOf(row).map(([key]) => key));
        return k.length === keys.length && k.every((x, i) => x === keys[i]);
      });
      if (keys.length > 0 && same) {
        const lens = keys.map((k) => utf8(k).length);
        const strhdr = (l) => (l <= 31 ? 1 : l <= 0xff ? 2 : l <= 0xffff ? 3 : 5);
        const perRow = (keys.length <= 15 ? 1 : keys.length <= 0xffff ? 3 : 5) + lens.reduce((a, l) => a + strhdr(l) + l, 0);
        const overhead = 18 + lens.reduce((a, l) => a + 9 + l, 0);
        if (v.length * perRow > overhead) {
          const get = (row, k) => (row instanceof Map ? row.get(k) : row[k]);
          const parts = [Uint8Array.from([...be(4, 1n), ...be(4, BigInt(keys.length)), ...be(4, BigInt(v.length))])];
          keys.forEach((k, i) => parts.push(Uint8Array.from(be(4, BigInt(lens[i]))), utf8(k)));
          parts.push(Uint8Array.from(keys.map((k) => typeCode(get(v[0], k)))));
          for (const k of keys) {
            const col = cat(...v.map((row) => refEncode(get(row, k), opts)));
            parts.push(Uint8Array.from(be(4, BigInt(col.length))), col);
          }
          return ext(-10, cat(...parts));
        }
      }
    }
    return cat(hdr(v.length, 0x90, 0xdc, 0xdd), ...v.map((e) => refEncode(e, opts)));
  }
  if (isMapLike(v)) {
    const entries = entriesOf(v);
    const sorted = sortKeys(entries.map(([k]) => k));
    const m = new Map(entries);
    return cat(hdr(sorted.length, 0x80, 0xde, 0xdf), ...sorted.flatMap((k) => [str(k), refEncode(m.get(k), opts)]));
  }
  throw new Error(`reference encoder: unsupported ${Object.prototype.toString.call(v)}`);
}
