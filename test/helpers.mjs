// Shared helpers for the test suite: hex, the typed-JSON vector form (SPEC §10), and the
// library builds under test.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every build of the library: ESM and CJS, Node and portable entries. */
export const builds = {
  'esm/node': await import('../dist/esm/node.js'),
  'esm/portable': await import('../dist/esm/index.js'),
  'cjs/node': require('../dist/cjs/node.js'),
  'cjs/portable': require('../dist/cjs/index.js'),
};

export function unhex(h) {
  if (h.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function hex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function loadVectors() {
  return JSON.parse(readFileSync(new URL('./vectors/btoon-vectors.json', import.meta.url), 'utf8'));
}

/** Maps a vector's snake_case "options" onto decode/encode options. Unknown keys fail loudly. */
export function vectorOptions(v) {
  const dec = {};
  const enc = {};
  for (const [k, val] of Object.entries(v.options ?? {})) {
    switch (k) {
      case 'hmac_key':
        dec.hmacKey = unhex(val);
        enc.hmacKey = unhex(val);
        break;
      case 'max_depth':
        dec.maxDepth = val;
        enc.maxDepth = val;
        break;
      case 'max_decompressed_size':
        dec.maxDecompressedSize = val;
        break;
      case 'strict':
        dec.strict = val;
        break;
      case 'auto_decompress':
        dec.autoDecompress = val;
        break;
      case 'auto_tabular':
        enc.autoTabular = val;
        break;
      default:
        throw new Error(`vector ${v.id}: unknown option ${k}`);
    }
  }
  return { dec, enc };
}

function parseFloatTyped(s) {
  if (s === 'NaN') return NaN;
  if (s === 'Infinity') return Infinity;
  if (s === '-Infinity') return -Infinity;
  return Number(s);
}

function be64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v);
  return b;
}

function floorDiv(a, b) {
  let q = a / b;
  let r = a % b;
  if (r < 0n) {
    r += b;
    q -= 1n;
  }
  return [q, r];
}

function one(typed) {
  const keys = Object.keys(typed);
  if (keys.length !== 1) throw new Error(`typed value must have one key: ${JSON.stringify(typed)}`);
  return [keys[0], typed[keys[0]]];
}

/**
 * Builds the JavaScript value whose canonical encoding is the vector. `date` and `datetime`
 * have no JavaScript type of their own (Date encodes as a timestamp), so they become Ext(-2)
 * and Ext(-3).
 */
export function fromTyped(typed, lib) {
  const [kind, x] = one(typed);
  switch (kind) {
    case 'nil':
      return null;
    case 'bool':
      return x;
    case 'int': {
      const b = BigInt(x);
      return b >= -BigInt(Number.MAX_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
    }
    case 'float':
      return parseFloatTyped(x);
    case 'string':
      return x;
    case 'binary':
      return unhex(x);
    case 'array':
      return x.map((e) => fromTyped(e, lib));
    case 'map': {
      const o = {};
      for (const [k, e] of Object.entries(x)) {
        Object.defineProperty(o, k, { value: fromTyped(e, lib), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    case 'timestamp':
      return new lib.Timestamp(BigInt(x.seconds), x.nanoseconds, x.offset_minutes);
    case 'date':
      return new lib.Ext(-2, be64(BigInt(x)));
    case 'datetime':
      return new lib.Ext(-3, be64(BigInt(x)));
    case 'float32_vector':
      return Float32Array.from(x.map(parseFloatTyped));
    case 'float64_vector':
      return Float64Array.from(x.map(parseFloatTyped));
    case 'ext':
      return new lib.Ext(x.type, unhex(x.data));
    default:
      throw new Error(`unknown typed kind ${kind}`);
  }
}

/**
 * False if the value contains a float that JavaScript can't distinguish from an integer
 * (such as 0.0): such a number encodes as an integer, so the vector can't be re-encoded.
 */
export function jsRepresentable(typed) {
  const [kind, x] = one(typed);
  if (kind === 'float') {
    const f = parseFloatTyped(x);
    return !(Number.isSafeInteger(f) && !Object.is(f, -0));
  }
  if (kind === 'array') return x.every(jsRepresentable);
  if (kind === 'map') return Object.values(x).every(jsRepresentable);
  return true;
}

function show(v) {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Uint8Array) return `Uint8Array(${hex(v)})`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function sameFloat(a, b) {
  return Number.isNaN(a) ? Number.isNaN(b) : Object.is(a, b);
}

/**
 * Semantic comparison against a typed value: NaN equals NaN, -0 differs from 0, integers
 * compare by value across number and bigint, maps ignore order. `opts.timestamps` is the
 * decode mode used. Returns null on a match, or a description of the first difference.
 */
export function mismatch(actual, typed, lib, opts, path = '$') {
  const [kind, x] = one(typed);
  const bad = (what) => `${path}: expected ${kind} ${show(x)}, got ${what ?? show(actual)}`;
  const tsObjects = opts.timestamps === 'object';
  switch (kind) {
    case 'nil':
      return actual === null ? null : bad();
    case 'bool':
      return actual === x ? null : bad();
    case 'int': {
      if (typeof actual !== 'bigint' && !(typeof actual === 'number' && Number.isInteger(actual))) return bad();
      if (BigInt(actual) !== BigInt(x)) return bad();
      if (opts.bigint !== 'always') {
        const safe = Number.isSafeInteger(Number(x)) && BigInt(Number(x)) === BigInt(x);
        if (typeof actual !== (safe ? 'number' : 'bigint')) return bad(`${typeof actual} ${show(actual)}`);
      }
      return null;
    }
    case 'float':
      return typeof actual === 'number' && sameFloat(actual, parseFloatTyped(x)) ? null : bad();
    case 'string':
      return actual === x ? null : bad();
    case 'binary':
      return actual instanceof Uint8Array && Object.getPrototypeOf(actual) === Uint8Array.prototype && hex(actual) === x
        ? null
        : bad();
    case 'array': {
      if (!Array.isArray(actual) || actual.length !== x.length) return bad();
      for (let i = 0; i < x.length; i++) {
        const m = mismatch(actual[i], x[i], lib, opts, `${path}[${i}]`);
        if (m) return m;
      }
      return null;
    }
    case 'map': {
      if (typeof actual !== 'object' || actual === null || Object.getPrototypeOf(actual) !== Object.prototype) return bad();
      const want = Object.keys(x).sort();
      const got = Object.keys(actual).sort();
      if (want.join('\u0000') !== got.join('\u0000')) return bad(`keys ${show(got)}`);
      for (const k of want) {
        const m = mismatch(actual[k], x[k], lib, opts, `${path}.${k}`);
        if (m) return m;
      }
      return null;
    }
    case 'timestamp':
    case 'date':
    case 'datetime': {
      let seconds;
      let nanos;
      let offset;
      if (kind === 'timestamp') {
        seconds = BigInt(x.seconds);
        nanos = x.nanoseconds;
        offset = x.offset_minutes;
      } else if (kind === 'date') {
        const [s, r] = floorDiv(BigInt(x), 1000n);
        seconds = s;
        nanos = Number(r) * 1e6;
      } else {
        const [s, r] = floorDiv(BigInt(x), 1000000000n);
        seconds = s;
        nanos = Number(r);
      }
      const ms = seconds * 1000n + BigInt(Math.floor(nanos / 1e6));
      // Instants outside the range of Date decode to Timestamp objects in every mode.
      if (tsObjects || ms > 8640000000000000n || ms < -8640000000000000n) {
        return actual instanceof lib.Timestamp &&
          actual.seconds === seconds &&
          actual.nanoseconds === nanos &&
          actual.offsetMinutes === offset
          ? null
          : bad(actual instanceof lib.Timestamp ? `Timestamp(${actual.seconds}, ${actual.nanoseconds}, ${actual.offsetMinutes})` : undefined);
      }
      return actual instanceof Date && actual.getTime() === Number(ms) ? null : bad();
    }
    case 'float32_vector':
    case 'float64_vector': {
      const Ctor = kind === 'float32_vector' ? Float32Array : Float64Array;
      if (!(actual instanceof Ctor) || actual.length !== x.length) return bad();
      for (let i = 0; i < x.length; i++) {
        const want = kind === 'float32_vector' ? Math.fround(parseFloatTyped(x[i])) : parseFloatTyped(x[i]);
        if (!sameFloat(actual[i], want)) return bad();
      }
      return null;
    }
    case 'ext':
      return actual instanceof lib.Ext && actual.type === x.type && hex(actual.data) === x.data ? null : bad();
    default:
      return `${path}: unknown typed kind ${kind}`;
  }
}

/** A small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
  };
}
