// Shared helpers for the test suite: hex, the typed-JSON vector form (SPEC §10), and the
// library builds under test.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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

/**
 * Maps a vector's snake_case "options" (SPEC §10) onto decode/encode options. Unknown keys
 * fail loudly. `hmac_key` is hex, and an empty string is an empty key (`invalid_argument`).
 */
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
      case 'max_values':
        dec.maxValues = val;
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

/**
 * The exact bits of a float vector element (SPEC §10): "NaN" is the canonical quiet NaN of
 * the width, "0x…" is a bit pattern (most significant byte first), anything else a number
 * rounded to the width (a float32 overflow becomes ±Infinity). Bits never pass through a
 * JavaScript number, which could change a NaN's payload.
 */
function elementBits(s, width) {
  if (s.startsWith('0x')) return BigInt(s);
  if (s === 'NaN') return width === 4 ? 0x7fc00000n : 0x7ff8000000000000n;
  const dv = new DataView(new ArrayBuffer(8));
  if (width === 4) {
    dv.setFloat32(0, parseFloatTyped(s));
    return BigInt(dv.getUint32(0));
  }
  dv.setFloat64(0, parseFloatTyped(s));
  return dv.getBigUint64(0);
}

/** A Float32Array or Float64Array whose elements have exactly the bits the vector gives. */
function vectorOf(kind, elements) {
  if (kind === 'float32_vector') {
    const bits = Uint32Array.from(elements, (e) => Number(elementBits(e, 4)));
    return new Float32Array(bits.buffer);
  }
  const bits = BigUint64Array.from(elements, (e) => elementBits(e, 8));
  return new Float64Array(bits.buffer);
}

const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

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
 * Builds the JavaScript value whose canonical encoding is the vector: `date` and `datetime`
 * are the typed values BtoonDate and BtoonDateTime (SPEC §10).
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
      return new lib.BtoonDate(BigInt(x));
    case 'datetime':
      return new lib.BtoonDateTime(BigInt(x));
    case 'float32_vector':
    case 'float64_vector':
      return vectorOf(kind, x);
    case 'ext':
      return new lib.Ext(x.type, unhex(x.data));
    default:
      throw new Error(`unknown typed kind ${kind}`);
  }
}

/**
 * False if the value has a part JavaScript can't represent distinctly, so the vector may skip
 * its re-encoding (SPEC §10): a float that JavaScript can't tell from an integer (such as
 * 0.0), which encodes as an integer. Everything else, date and datetime included, must
 * re-encode.
 */
export function reencodable(typed) {
  const [kind, x] = one(typed);
  if (kind === 'float') {
    const f = parseFloatTyped(x);
    return !(Number.isSafeInteger(f) && !Object.is(f, -0));
  }
  if (kind === 'array') return x.every(reencodable);
  if (kind === 'map') return Object.values(x).every(reencodable);
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

const INT32_MIN = -(2n ** 31n);
const UINT32_MAX = 2n ** 32n - 1n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Semantic comparison against a typed value: NaN equals NaN, -0 differs from 0, an integer is
 * a number or a bigint as `opts.bigint` says (by its value), maps ignore order. Instants are
 * Dates, or with `opts.timestamps: 'object'` instances of exactly Timestamp, BtoonDate or
 * BtoonDateTime. Returns null on a match, or a description of the first difference.
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
      const want = BigInt(x);
      if (BigInt(actual) !== want) return bad();
      const asNumber = opts.bigint === 'always' ? want >= INT32_MIN && want <= UINT32_MAX : want >= -SAFE && want <= SAFE;
      if (typeof actual !== (asNumber ? 'number' : 'bigint')) return bad(`${typeof actual} ${show(actual)}`);
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
      // Instants outside the range of Date decode to typed objects in every mode.
      if (tsObjects || ms > 8640000000000000n || ms < -8640000000000000n) {
        const [Class, epoch] =
          kind === 'date' ? [lib.BtoonDate, 'epochMilliseconds'] : kind === 'datetime' ? [lib.BtoonDateTime, 'epochNanoseconds'] : [lib.Timestamp];
        const describe = () =>
          typeof actual === 'object' && actual !== null
            ? `${actual.constructor?.name}(${actual.seconds}, ${actual.nanoseconds}, ${actual.offsetMinutes}${epoch ? `, ${actual[epoch]}` : ''})`
            : undefined;
        return actual instanceof Class &&
          Object.getPrototypeOf(actual) === Class.prototype &&
          actual.seconds === seconds &&
          actual.nanoseconds === nanos &&
          actual.offsetMinutes === offset &&
          (epoch === undefined || actual[epoch] === BigInt(x))
          ? null
          : bad(describe());
      }
      return actual instanceof Date && actual.getTime() === Number(ms) ? null : bad();
    }
    case 'float32_vector':
    case 'float64_vector': {
      // Vectors are opaque buffers: elements compare bit for bit, NaN payloads included.
      const Ctor = kind === 'float32_vector' ? Float32Array : Float64Array;
      if (!(actual instanceof Ctor) || actual.length !== x.length) return bad();
      const want = hex(bytesOf(vectorOf(kind, x)));
      const got = hex(bytesOf(actual));
      return got === want ? null : bad(`${Ctor.name} with bytes ${got}, expected ${want}`);
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

/** A compression envelope (SPEC §6) of algorithm id `algo` around `payload`. */
export function compressionEnvelope(algo, payload, usize) {
  const out = new Uint8Array(16 + payload.length);
  out.set([0x42, 0x54, 0x4f, 0x4e, 1, algo, 0, 0]);
  const v = new DataView(out.buffer);
  v.setUint32(8, payload.length);
  v.setUint32(12, usize);
  out.set(payload, 16);
  return out;
}

function concatBytes(...parts) {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

/**
 * Compressed payloads on which decodeAsync must reach decode's verdict (review 2026-11-13,
 * X2): valid streams, streams followed by junk (one variant ends in a copy of the zlib
 * stream's Adler-32), a zlib stream that requires a preset dictionary, and Zstandard frames
 * whose window exceeds the SPEC §6 bound. Returns [name, envelope] pairs for the bare
 * document `doc`.
 */
export function compressedCases(doc) {
  const junk = new TextEncoder().encode('ANY BYTES AN ATTACKER LIKES');
  const z = zlib.deflateSync(doc);
  const br = zlib.brotliCompressSync(doc);
  const cases = [
    ['zlib', compressionEnvelope(0, z, doc.length)],
    ['zlib + junk', compressionEnvelope(0, concatBytes(z, [1, 2, 3]), doc.length)],
    ['zlib + junk ending in its Adler-32', compressionEnvelope(0, concatBytes(z, junk, z.subarray(z.length - 4)), doc.length)],
    ['zlib + second stream', compressionEnvelope(0, concatBytes(z, z), doc.length)],
    ['zlib with FDICT', unhex('42544f4e01000000000000120000000678bb000000015b9a919a93930f000a0b02ba')],
    ['brotli', compressionEnvelope(3, br, doc.length)],
    ['brotli + junk', compressionEnvelope(3, concatBytes(br, junk), doc.length)],
    ['brotli + one byte', compressionEnvelope(3, concatBytes(br, [0]), doc.length)],
  ];
  if (typeof zlib.zstdCompressSync === 'function') {
    const C = zlib.constants;
    const zs = zlib.zstdCompressSync(doc);
    const frame = new Uint8Array(zlib.zstdCompressSync(doc, { params: { [C.ZSTD_c_windowLog]: 20, [C.ZSTD_c_contentSizeFlag]: 0 } }));
    const withWindow = (log) => {
      const f = Uint8Array.from(frame);
      f[5] = (log - 10) << 3; // Window_Descriptor: the frame declares a 2^log window
      return compressionEnvelope(2, f, doc.length);
    };
    cases.push(
      ['zstd', compressionEnvelope(2, zs, doc.length)],
      ['zstd + junk', compressionEnvelope(2, concatBytes(zs, junk), doc.length)],
      ['zstd + second frame', compressionEnvelope(2, concatBytes(zs, zs), doc.length)],
      ['zstd, 8 MiB window', withWindow(23)],
      ['zstd, 16 MiB window', withWindow(24)],
      ['zstd, 128 MiB window', withWindow(27)],
    );
  }
  return cases;
}

/** The value a (possibly async) call returns, or the code of the BtoonError it throws. */
export async function verdict(fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    if (e?.name !== 'BtoonError') throw e;
    return { code: e.code };
  }
}
