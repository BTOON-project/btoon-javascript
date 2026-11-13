// Hardened BTOON decoder (SPEC §7). Invariants:
//  * every read is bounds-checked against `end` (no reads past the input);
//  * containers are depth-limited (max_depth) — no unbounded recursion;
//  * nothing is allocated beyond what the remaining input could encode, and what containers
//    allocate before their elements are decoded is bounded for the whole document.
import {
  DEFAULT_MAX_DEPTH,
  EXT_BIGINT,
  EXT_DATE,
  EXT_DATETIME,
  EXT_F32_VECTOR,
  EXT_F64_VECTOR,
  EXT_TABULAR,
  EXT_TIMESTAMP,
  MAX_DATE_MS,
  MAX_OFFSET_MINUTES,
  NANOS_PER_SECOND,
  TABULAR_VERSION,
} from './constants.js';
import { BtoonError, fail, isStackOverflow, type BtoonErrorCode } from './errors.js';
import type { DecodeConfig } from './options.js';
import { decodeUtf8 } from './utf8.js';
import { Ext, Timestamp } from './values.js';

const TWO_32 = 4294967296;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const MAX_DATE_SECONDS = MAX_DATE_MS / 1000;
const hasOwn = Object.prototype.hasOwnProperty;
const fromCharCode = String.fromCharCode;

// Map keys repeat across records, so short ASCII keys are cached. A hit is verified
// byte-for-byte, so a collision only costs a miss; the cached strings are already
// internalized, which also makes the property stores cheaper.
const KEY_CACHE_SIZE = 4096;
const KEY_CACHE_MAX_LEN = 16;
const keyCache: (string | undefined)[] = new Array<string | undefined>(KEY_CACHE_SIZE).fill(undefined);

// Limits on what containers allocate before their elements are decoded. A header may announce
// as many elements as there are bytes left, but nested containers announce the same bytes
// again at every level, so trusting the counts let a 1 MiB document of 64 nested tabulars
// build 4 GB of rows and exhaust the heap (review 2026-11-13, X1). An array, or the row list
// of a table, reserves at most MAX_RESERVE slots, and those open at any time at most
// RESERVE_BUDGET together; beyond that they grow as elements are decoded. Each tabular row is
// created once its first cell has been decoded.
const MAX_RESERVE = 1024;
const RESERVE_BUDGET = 64 * MAX_RESERVE;

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));

/** Sets `obj[key] = value` as an own data property; `__proto__` never touches the prototype. */
function setProperty(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

function floorDiv(a: bigint, b: bigint): [bigint, bigint] {
  let q = a / b;
  let r = a % b;
  if (r < 0n) {
    r += b;
    q -= 1n;
  }
  return [q, r];
}

/** A plain Uint8Array view of the same bytes (Buffer.prototype.slice does not copy). */
export function plainBytes(b: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(b) === Uint8Array.prototype ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

class Decoder {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos = 0;
  end: number;
  readonly strict: boolean;
  readonly maxDepth: number;
  readonly tsObjects: boolean;
  readonly bigAlways: boolean;
  /** Slots reserved by the arrays and row lists being decoded (see reserve). */
  private reserved = 0;

  constructor(bytes: Uint8Array, strict: boolean, maxDepth: number, tsObjects: boolean, bigAlways: boolean) {
    this.bytes = plainBytes(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.end = this.bytes.length;
    this.strict = strict;
    this.maxDepth = maxDepth;
    this.tsObjects = tsObjects;
    this.bigAlways = bigAlways;
  }

  err(code: BtoonErrorCode, message: string, at: number = this.pos): BtoonError {
    return fail(code, `${message} (at byte ${at})`);
  }

  private need(n: number): void {
    if (this.end - this.pos < n) throw this.err('truncated', 'unexpected end of input');
  }

  private u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  private u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  private u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  value(depth: number): unknown {
    if (this.pos >= this.end) throw this.err('truncated', 'unexpected end of input');
    const m = this.bytes[this.pos++]!;
    if (m < 0x80) return m;
    if (m >= 0xe0) return m - 0x100;
    if (m < 0x90) return this.map(m & 0x0f, depth);
    if (m < 0xa0) return this.array(m & 0x0f, depth);
    if (m < 0xc0) return this.str(m & 0x1f);
    const view = this.view;
    let v: number;
    switch (m) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bin(this.u8());
      case 0xc5:
        return this.bin(this.u16());
      case 0xc6:
        return this.bin(this.u32());
      case 0xc7:
        return this.ext(this.u8(), depth);
      case 0xc8:
        return this.ext(this.u16(), depth);
      case 0xc9:
        return this.ext(this.u32(), depth);
      case 0xca:
        this.need(4);
        v = view.getFloat32(this.pos);
        this.pos += 4;
        return v;
      case 0xcb:
        this.need(8);
        v = view.getFloat64(this.pos);
        this.pos += 8;
        return v;
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return this.uint64();
      case 0xd0:
        this.need(1);
        return view.getInt8(this.pos++);
      case 0xd1:
        this.need(2);
        v = view.getInt16(this.pos);
        this.pos += 2;
        return v;
      case 0xd2:
        this.need(4);
        v = view.getInt32(this.pos);
        this.pos += 4;
        return v;
      case 0xd3:
        return this.int64();
      case 0xd4:
        return this.ext(1, depth);
      case 0xd5:
        return this.ext(2, depth);
      case 0xd6:
        return this.ext(4, depth);
      case 0xd7:
        return this.ext(8, depth);
      case 0xd8:
        return this.ext(16, depth);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16(), depth);
      case 0xdd:
        return this.array(this.u32(), depth);
      case 0xde:
        return this.map(this.u16(), depth);
      case 0xdf:
        return this.map(this.u32(), depth);
      default: // 0xc1
        throw this.err('invalid_marker', 'reserved marker 0xc1', this.pos - 1);
    }
  }

  private uint64(): number | bigint {
    this.need(8);
    const p = this.pos;
    this.pos += 8;
    const hi = this.view.getUint32(p);
    if (!this.bigAlways && hi < 0x200000) return hi * TWO_32 + this.view.getUint32(p + 4);
    return this.view.getBigUint64(p);
  }

  private int64(): number | bigint {
    this.need(8);
    const p = this.pos;
    this.pos += 8;
    if (!this.bigAlways) {
      // Exact whenever the result is a safe integer; never safe-looking when it isn't.
      const v = this.view.getInt32(p) * TWO_32 + this.view.getUint32(p + 4);
      if (Number.isSafeInteger(v)) return v;
    }
    return this.view.getBigInt64(p);
  }

  private str(len: number): string {
    if (len > this.end - this.pos) throw this.err('truncated', 'string runs past the end of input');
    const s = decodeUtf8(this.bytes, this.pos, len, this.strict);
    if (s === undefined) throw this.err('invalid_utf8', 'string is not valid UTF-8');
    this.pos += len;
    return s;
  }

  private bin(len: number): Uint8Array {
    if (len > this.end - this.pos) throw this.err('truncated', 'binary runs past the end of input');
    const b = this.bytes.slice(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  /**
   * How many of the `n` elements that an array, or a table's row list, announces it may
   * allocate up front. They are charged to the document's budget until it is complete.
   */
  private reserve(n: number): number {
    const r = Math.min(n, MAX_RESERVE, RESERVE_BUDGET - this.reserved);
    this.reserved += r;
    return r;
  }

  private array(n: number, depth: number): unknown[] {
    if (depth >= this.maxDepth) throw this.err('max_depth', 'maximum nesting depth exceeded');
    // Every element takes at least one byte.
    if (n > this.end - this.pos) throw this.err('truncated', 'array length exceeds the remaining input');
    const r = this.reserve(n);
    const a = new Array<unknown>(r); // grows as elements beyond the reservation arrive
    for (let i = 0; i < n; i++) a[i] = this.value(depth + 1);
    this.reserved -= r;
    return a;
  }

  private key(): string {
    if (this.pos >= this.end) throw this.err('truncated', 'unexpected end of input');
    const m = this.bytes[this.pos]!;
    let len: number;
    if (m >= 0xa0 && m <= 0xbf) {
      this.pos++;
      len = m & 0x1f;
    } else if (m === 0xd9) {
      this.pos++;
      len = this.u8();
    } else if (m === 0xda) {
      this.pos++;
      len = this.u16();
    } else if (m === 0xdb) {
      this.pos++;
      len = this.u32();
    } else {
      throw this.err('non_string_key', 'map key is not a string');
    }
    if (len <= KEY_CACHE_MAX_LEN && len <= this.end - this.pos) {
      const bytes = this.bytes;
      const p = this.pos;
      let h = len;
      let high = 0;
      for (let i = p; i < p + len; i++) {
        const b = bytes[i]!;
        h = (Math.imul(h, 31) + b) | 0;
        high |= b;
      }
      if (high < 0x80) {
        const slot = h & (KEY_CACHE_SIZE - 1);
        let s = keyCache[slot];
        if (s !== undefined && s.length === len) {
          let i = 0;
          while (i < len && s.charCodeAt(i) === bytes[p + i]) i++;
          if (i === len) {
            this.pos = p + len;
            return s;
          }
        }
        s = len === 0 ? '' : fromCharCode.apply(null, bytes.subarray(p, p + len) as unknown as number[]);
        keyCache[slot] = s;
        this.pos = p + len;
        return s;
      }
    }
    return this.str(len);
  }

  private map(n: number, depth: number): Record<string, unknown> {
    if (depth >= this.maxDepth) throw this.err('max_depth', 'maximum nesting depth exceeded');
    // Every entry takes at least two bytes.
    if (n > (this.end - this.pos) / 2) throw this.err('truncated', 'map length exceeds the remaining input');
    const obj: Record<string, unknown> = {};
    // While keys arrive strictly increasing (as in canonical input) none can repeat; after
    // the first out-of-order key every key is checked against the object.
    let prev = '';
    let ordered = true;
    for (let i = 0; i < n; i++) {
      const k = this.key();
      const v = this.value(depth + 1);
      if (ordered && (i === 0 || prev < k)) {
        prev = k;
      } else {
        ordered = false;
        // Decoded values are never undefined, so this skips hasOwn for fresh keys.
        if (obj[k] !== undefined && hasOwn.call(obj, k) && this.strict) {
          throw this.err('duplicate_key', `duplicate map key ${JSON.stringify(k)}`);
        }
      }
      setProperty(obj, k, v);
    }
    return obj;
  }

  private ext(len: number, depth: number): unknown {
    this.need(1);
    const type = this.view.getInt8(this.pos++);
    if (len > this.end - this.pos) throw this.err('truncated', 'extension payload runs past the end of input');
    const start = this.pos;
    this.pos = start + len;
    return this.extValue(type, start, len, depth);
  }

  /** Interprets the payload `bytes[start, start+len)` of an extension of `type`. */
  extValue(type: number, start: number, len: number, depth: number): unknown {
    const view = this.view;
    const bad = (what: string): BtoonError => this.err('invalid_extension', what, start);
    switch (type) {
      case EXT_TIMESTAMP: {
        let sec: number | bigint;
        let ns: number;
        let off: number | undefined;
        switch (len) {
          case 4:
            sec = view.getUint32(start);
            ns = 0;
            break;
          case 8: {
            const hi = view.getUint32(start);
            ns = hi >>> 2;
            sec = (hi & 3) * TWO_32 + view.getUint32(start + 4);
            break;
          }
          case 12:
          case 14:
            ns = view.getUint32(start);
            sec = view.getBigInt64(start + 4);
            if (len === 14) {
              off = view.getInt16(start + 12);
              if (off < -MAX_OFFSET_MINUTES || off > MAX_OFFSET_MINUTES) throw bad('timestamp offset out of range');
            }
            break;
          default:
            throw bad('invalid timestamp length');
        }
        if (ns >= NANOS_PER_SECOND) throw bad('timestamp nanoseconds out of range');
        return this.instant(sec, ns, off);
      }
      case EXT_DATE: {
        if (len !== 8) throw bad('invalid date length');
        const ms = view.getBigInt64(start);
        if (!this.tsObjects && ms <= BigInt(MAX_DATE_MS) && ms >= -BigInt(MAX_DATE_MS)) return new Date(Number(ms));
        const [s, r] = floorDiv(ms, 1000n);
        return new Timestamp(s, Number(r) * 1e6);
      }
      case EXT_DATETIME: {
        if (len !== 8) throw bad('invalid datetime length');
        const ns = view.getBigInt64(start);
        if (!this.tsObjects) return new Date(Number(floorDiv(ns, 1000000n)[0]));
        const [s, r] = floorDiv(ns, 1000000000n);
        return new Timestamp(s, Number(r));
      }
      case EXT_BIGINT:
        if (len === 0) throw bad('empty bigint');
        return this.bigint(start, len);
      case EXT_F32_VECTOR:
      case EXT_F64_VECTOR: {
        const size = type === EXT_F32_VECTOR ? 4 : 8;
        if (len % size !== 0) throw bad(`float${size * 8} vector length is not a multiple of ${size}`);
        // Always a fresh, aligned copy: never a view into the input.
        const out = type === EXT_F32_VECTOR ? new Float32Array(len / 4) : new Float64Array(len / 8);
        const raw = new Uint8Array(out.buffer);
        raw.set(this.bytes.subarray(start, start + len));
        if (!LITTLE_ENDIAN) {
          for (let i = 0; i < len; i += size) raw.subarray(i, i + size).reverse();
        }
        return out;
      }
      case EXT_TABULAR:
        return this.tabular(start, len, depth);
      default:
        return new Ext(type, this.bytes.slice(start, start + len));
    }
  }

  /** A timestamp as a Date (default) or a Timestamp (`timestamps: 'object'`, or out of Date range). */
  private instant(sec: number | bigint, ns: number, off: number | undefined): Date | Timestamp {
    if (!this.tsObjects) {
      const s = typeof sec === 'number' ? sec : sec <= BigInt(MAX_DATE_SECONDS) && sec >= -BigInt(MAX_DATE_SECONDS) ? Number(sec) : NaN;
      const ms = s * 1000 + Math.floor(ns / 1e6);
      if (ms <= MAX_DATE_MS && ms >= -MAX_DATE_MS) return new Date(ms);
    }
    return new Timestamp(sec, ns, off);
  }

  private bigint(start: number, len: number): number | bigint {
    const bytes = this.bytes;
    let v: bigint;
    try {
      let hex = '';
      if (len <= 64) {
        for (let i = start; i < start + len; i++) hex += HEX[bytes[i]!];
      } else {
        const parts = new Array<string>(len);
        for (let i = 0; i < len; i++) parts[i] = HEX[bytes[start + i]!]!;
        hex = parts.join('');
      }
      v = BigInt('0x' + hex);
      if (bytes[start]! >= 0x80) v -= 1n << BigInt(len * 8);
    } catch (e) {
      throw fail('size_limit', `bigint too large for this JavaScript engine (at byte ${start})`, e);
    }
    if (!this.bigAlways && v >= -0x1fffffffffffffn && v <= 0x1fffffffffffffn) return Number(v);
    return v;
  }

  private tabular(start: number, len: number, depth: number): unknown[] {
    if (depth + 1 >= this.maxDepth) throw this.err('max_depth', 'maximum nesting depth exceeded', start);
    const view = this.view;
    const end = start + len;
    let p = start;
    const bad = (what: string): BtoonError => this.err('invalid_tabular', what, p);
    if (end - p < 12) throw bad('tabular payload truncated');
    const version = view.getUint32(p);
    const cols = view.getUint32(p + 4);
    const rowCount = view.getUint32(p + 8);
    p += 12;
    if (version !== TABULAR_VERSION) throw bad(`unsupported tabular version ${version}`);
    if (cols === 0 && rowCount > 0) throw bad('tabular rows without columns');
    // Each column needs at least 9 bytes: name length, type code, column length.
    if (cols > (end - p) / 9) throw bad('tabular column count exceeds the payload');
    const names: string[] = [];
    for (let c = 0; c < cols; c++) {
      if (end - p < 4) throw bad('tabular payload truncated');
      const n = view.getUint32(p);
      p += 4;
      if (n > end - p) throw bad('tabular column name runs past the payload');
      const name = decodeUtf8(this.bytes, p, n, this.strict);
      if (name === undefined) throw this.err('invalid_utf8', 'column name is not valid UTF-8', p);
      names.push(name);
      p += n;
    }
    if (new Set(names).size !== cols) throw bad('duplicate tabular column name');
    if (cols > end - p) throw bad('tabular payload truncated');
    p += cols; // type codes are informational (SPEC §5.6.1)
    // Every cell is at least one byte.
    if (rowCount * cols > end - p) throw bad('tabular row count exceeds the payload');
    // Each row is created once its first cell has been decoded, so the rows are backed by
    // input actually consumed, however many the header announces.
    const reserved = this.reserve(rowCount);
    const rows = new Array<Record<string, unknown>>(reserved);
    const savedEnd = this.end;
    for (let c = 0; c < cols; c++) {
      if (end - p < 4) throw bad('tabular payload truncated');
      const colLen = view.getUint32(p);
      p += 4;
      if (colLen > end - p) throw bad('tabular column runs past the payload');
      const colEnd = p + colLen;
      const name = names[c]!;
      this.pos = p;
      this.end = colEnd;
      try {
        if (c === 0) {
          for (let r = 0; r < rowCount; r++) {
            const v = this.value(depth + 2);
            const row: Record<string, unknown> = {};
            setProperty(row, name, v);
            rows[r] = row;
          }
        } else if (name === '__proto__') {
          for (let r = 0; r < rowCount; r++) setProperty(rows[r]!, name, this.value(depth + 2));
        } else {
          for (let r = 0; r < rowCount; r++) rows[r]![name] = this.value(depth + 2);
        }
      } catch (e) {
        if (e instanceof BtoonError && e.code === 'truncated') {
          throw fail('invalid_tabular', `tabular column holds fewer values than rows (at byte ${this.pos})`, e);
        }
        throw e;
      }
      if (this.pos !== colEnd) throw this.err('invalid_tabular', 'tabular column length mismatch');
      p = colEnd;
    }
    this.end = savedEnd;
    this.reserved -= reserved;
    if (p !== end) throw bad('trailing bytes in tabular payload');
    this.pos = end;
    return rows;
  }
}

/** Decodes one bare BTOON document (no envelopes). */
export function decodeDocument(bytes: Uint8Array, cfg: DecodeConfig): unknown {
  const d = new Decoder(bytes, cfg.strict, cfg.maxDepth, cfg.timestampObjects, cfg.bigintAlways);
  let v: unknown;
  try {
    v = d.value(0);
  } catch (e) {
    if (isStackOverflow(e)) throw fail('max_depth', 'input nests too deeply for the JavaScript call stack', e);
    throw e;
  }
  if (d.pos !== d.end && cfg.strict) throw d.err('trailing_data', 'trailing bytes after the top-level value');
  return v;
}

/**
 * Used by the encoder: an `Ext` that carries a BTOON-defined id must hold a payload a
 * strict decoder accepts, so the encoder never emits a document decoders reject.
 */
export function validateBtoonExt(type: number, data: Uint8Array, depth: number, maxDepth: number = DEFAULT_MAX_DEPTH): void {
  if (!((type <= EXT_TIMESTAMP && type >= EXT_F64_VECTOR) || type === EXT_TABULAR)) return;
  const d = new Decoder(data, true, maxDepth, true, true);
  try {
    d.extValue(type, 0, d.end, depth);
  } catch (e) {
    if (e instanceof BtoonError) {
      throw fail('invalid_argument', `Ext(${type}) does not hold a valid payload for that BTOON type: ${e.message}`, e);
    }
    if (isStackOverflow(e)) throw fail('max_depth', 'Ext payload nests too deeply', e);
    throw e;
  }
}
