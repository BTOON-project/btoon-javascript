// Canonical BTOON encoder (SPEC §4–§5). Everything is appended to one growable buffer;
// tabular payloads and column lengths are back-patched.
import {
  EXT_BIGINT,
  EXT_DATE,
  EXT_DATETIME,
  EXT_F32_VECTOR,
  EXT_F64_VECTOR,
  EXT_TABULAR,
  EXT_TIMESTAMP,
  MAX_OFFSET_MINUTES,
  NANOS_PER_SECOND,
  TABULAR_VERSION,
} from './constants.js';
import { fail, isStackOverflow } from './errors.js';
import { compareUtf8, isWellFormed, loneSurrogateError, textEncoder, utf8Length } from './utf8.js';
import {
  dateTime,
  isBtoonDate,
  isBtoonDateTime,
  isExt,
  isTimestamp,
  isUint8Array,
  typedArrayType,
  bufferBytes,
  viewBytes,
  type BtoonDate,
  type BtoonDateTime,
  type Ext,
  type Timestamp,
} from './values.js';

const TWO_32 = 4294967296;
const TWO_34 = 17179869184;
const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MIN = -(1n << 63n);
const INT63 = 1n << 63n;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// Object kinds. The native `btoon` package classifies with the same numbers (index.js), so
// keep the two in step.
const K_ARRAY = 1;
/** Prototype Object.prototype or null, without an own toJSON(). */
const K_PLAIN = 2;
const K_VIEW = 3;
const K_BUFFER = 4;
const K_DATE = 5;
/** A Map (any realm, subclasses included): read with the intrinsic Map methods. */
const K_MAP = 6;
const K_TIMESTAMP = 7;
const K_EXT = 8;
/** An object with toJSON(): a class's, or a plain object's own. */
const K_TOJSON = 9;
/** A Number, String, Boolean or BigInt wrapper object (unwrapped, as JSON.stringify does). */
const K_BOXED = 10;
/** Any other object: encoded like JSON.stringify, as a map of its own enumerable string keys. */
const K_OBJECT = 11;
/** A BtoonDate (extension -2). */
const K_BTOON_DATE = 12;
/** A BtoonDateTime (extension -3). */
const K_BTOON_DATETIME = 13;
/**
 * Inherits from Map.prototype without being a Map: a Proxy of one, such as Vue's and MobX's
 * reactive Maps. Read through its own keys() and get(), which those proxies forward to the Map.
 */
const K_PROXY_MAP = 14;

const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const mapKeysOf = Map.prototype.keys;
const mapGet = Map.prototype.get;
const NOT_BOXED: unique symbol = Symbol('not boxed');
const BOXES = new Map<string, { valueOf(): unknown }>([
  ['[object Number]', Number.prototype],
  ['[object String]', String.prototype],
  ['[object Boolean]', Boolean.prototype],
  ['[object BigInt]', BigInt.prototype],
]);

/** The primitive inside a wrapper object, checked by internal slot (a spoofed tag fails). */
function unbox(o: object, tag: string = objectToString.call(o)): unknown {
  const proto = BOXES.get(tag);
  if (proto === undefined) return NOT_BOXED;
  try {
    return proto.valueOf.call(o);
  } catch {
    return NOT_BOXED;
  }
}

/** True for a Map of any realm (it has [[MapData]]); false for a Proxy of one. */
function isMap(o: object): boolean {
  try {
    mapSize.call(o);
    return true;
  } catch {
    return false;
  }
}

/**
 * A plain object's own toJSON(), which JSON.stringify calls. An inherited one, such as a
 * polluted Object.prototype.toJSON, is ignored.
 */
function ownToJSON(o: object): boolean {
  return typeof (o as { toJSON?: unknown }).toJSON === 'function' && hasOwn.call(o, 'toJSON');
}

function classify(o: object): number {
  if (Array.isArray(o)) return K_ARRAY;
  const proto: unknown = Object.getPrototypeOf(o);
  if (proto === Object.prototype || proto === null) return ownToJSON(o) ? K_TOJSON : K_PLAIN;
  if (ArrayBuffer.isView(o)) return K_VIEW;
  if (o instanceof Date) return K_DATE;
  if (o instanceof Map) return isMap(o) ? K_MAP : K_PROXY_MAP;
  if (isTimestamp(o)) return isBtoonDateTime(o) ? K_BTOON_DATETIME : isBtoonDate(o) ? K_BTOON_DATE : K_TIMESTAMP;
  if (isExt(o)) return K_EXT;
  const tag = objectToString.call(o);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return K_BUFFER;
  if (tag === '[object Date]') return K_DATE; // from another realm
  if (tag === '[object Map]' && isMap(o)) return K_MAP; // from another realm
  if (typeof (o as { toJSON?: unknown }).toJSON === 'function') return K_TOJSON;
  if (unbox(o, tag) !== NOT_BOXED) return K_BOXED;
  return K_OBJECT; // class instances, and plain objects from another realm
}

/** What to encode instead of a raw `Ext` with a BTOON-defined id, indexed by -id. */
const TYPED_INSTEAD: Record<number, string> = {
  1: 'encode a Date or Timestamp',
  2: 'encode a BtoonDate',
  3: 'encode a BtoonDateTime',
  4: 'encode a bigint',
  5: 'encode a Float32Array',
  6: 'encode a Float64Array',
  10: 'encode an array of objects, which uses the tabular encoding where it is smaller',
};

function maxDepthError(): Error {
  return fail('max_depth', 'maximum nesting depth exceeded (or the value is cyclic)');
}

/**
 * The keys of a Map, or null if one isn't a string. A Map's keys are read with the intrinsic
 * Map.prototype.keys, so a subclass's own iterator can't repeat one. A proxied Map's come from
 * its own keys(), which must not repeat one either.
 */
function stringKeys(m: Map<unknown, unknown>, kind: number): string[] | null {
  const keys: string[] = [];
  for (const k of kind === K_MAP ? mapKeysOf.call(m) : m.keys()) {
    if (typeof k !== 'string') return null;
    keys.push(k);
  }
  if (kind === K_PROXY_MAP && keys.length > 1 && new Set(keys).size !== keys.length) {
    throw fail('invalid_argument', 'a Map yielded the same key twice');
  }
  return keys;
}

/** Keys of a value that encodes as a map, or null. Non-string Map keys → null. */
function mapKeys(v: unknown, kind: number): string[] | null {
  if (kind === K_PLAIN || kind === K_OBJECT) return Object.keys(v as object);
  if (kind === K_MAP || kind === K_PROXY_MAP) return stringKeys(v as Map<unknown, unknown>, kind);
  return null;
}

function kindOf(v: unknown): number {
  return typeof v === 'object' && v !== null ? classify(v) : 0;
}

function callToJSON(o: object): unknown {
  return (o as { toJSON(): unknown }).toJSON();
}

/** The value of a map-like value at `key`; `kind` is its kind. */
function entry(m: unknown, kind: number, key: string): unknown {
  if (kind === K_MAP) return mapGet.call(m as Map<unknown, unknown>, key);
  if (kind === K_PROXY_MAP) return (m as Map<unknown, unknown>).get(key);
  return (m as Record<string, unknown>)[key];
}

/**
 * SPEC §5.6.1 type code of the value whose canonical encoding starts at `buf[p]`: the logical
 * type, read off the encoding as the spec says (and as btoon-core does). A tabular extension
 * is an array (7); every other extension is 9.
 */
function typeCodeAt(buf: Uint8Array, p: number): number {
  const m = buf[p]!;
  if (m <= 0x7f || m >= 0xe0) return 2; // fixints
  if (m <= 0x8f) return 8; // fixmap
  if (m <= 0x9f) return 7; // fixarray
  if (m <= 0xbf) return 5; // fixstr
  const ext = (typeAt: number): number => (buf[p + typeAt] === (EXT_TABULAR & 0xff) ? 7 : 9);
  switch (m) {
    case 0xc0:
      return 0;
    case 0xc2:
    case 0xc3:
      return 1;
    case 0xc4:
    case 0xc5:
    case 0xc6:
      return 6;
    case 0xca:
    case 0xcb:
      return 4;
    case 0xcf:
      return buf[p + 1]! >= 0x80 ? 3 : 2; // above 2^63 - 1
    case 0xcc:
    case 0xcd:
    case 0xce:
    case 0xd0:
    case 0xd1:
    case 0xd2:
    case 0xd3:
      return 2;
    case 0xd9:
    case 0xda:
    case 0xdb:
      return 5;
    case 0xdc:
    case 0xdd:
      return 7;
    case 0xde:
    case 0xdf:
      return 8;
    case 0xd4:
    case 0xd5:
    case 0xd6:
    case 0xd7:
    case 0xd8:
      return ext(1);
    case 0xc7:
      return ext(2);
    case 0xc8:
      return ext(3);
    case 0xc9:
      return ext(5);
    default:
      return 9;
  }
}

/** Minimal two's-complement big-endian bytes (SPEC §5.4). */
function bigintBytes(v: bigint): Uint8Array {
  let hex: string;
  if (v >= 0n) {
    hex = v.toString(16);
    if (hex.length & 1) hex = '0' + hex;
    if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = '00' + hex;
  } else {
    const bytes = ((-v).toString(16).length >> 1) + 2;
    hex = ((1n << BigInt(bytes * 8)) + v).toString(16);
    if (hex.length & 1) hex = '0' + hex;
    while (hex.length > 2 && hex.charCodeAt(0) === 0x66 && hex.charCodeAt(1) === 0x66 && parseInt(hex[2]!, 16) >= 8) {
      hex = hex.slice(2);
    }
  }
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface TabularPlan {
  /** The rows as planned, toJSON() results in place of their objects. */
  rows: readonly unknown[];
  kinds: Uint8Array;
  keys: string[];
  lens: number[];
}

class Encoder {
  buf: Uint8Array;
  view: DataView;
  pos = 0;
  readonly maxDepth: number;
  readonly autoTabular: boolean;
  // Out-parameters of planTabular() when it declines.
  private items: readonly unknown[] = [];
  private resolvedUpTo = 0;

  constructor(buf: Uint8Array, maxDepth: number, autoTabular: boolean) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.maxDepth = maxDepth;
    this.autoTabular = autoTabular;
  }

  // --- buffer --------------------------------------------------------------------

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) this.grow(n);
  }

  private grow(n: number): void {
    const need = this.pos + n;
    let cap = this.buf.length * 2;
    if (cap < need) cap = need;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  private u8(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  private bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  // --- dispatch ------------------------------------------------------------------

  value(v: unknown, depth: number): void {
    this.any(v, depth, true);
  }

  /** Encodes a value that already went through toJSON(): no second toJSON() call. */
  private resolved(v: unknown, depth: number): void {
    this.any(v, depth, false);
  }

  private any(v: unknown, depth: number, allowToJSON: boolean): void {
    switch (typeof v) {
      case 'string':
        this.string(v);
        return;
      case 'number':
        this.number(v);
        return;
      case 'boolean':
        this.u8(v ? 0xc3 : 0xc2);
        return;
      case 'object':
        if (v === null) this.u8(0xc0);
        else this.object(v, classify(v), depth, allowToJSON);
        return;
      case 'undefined':
        this.u8(0xc0);
        return;
      case 'bigint':
        this.bigint(v);
        return;
      default:
        throw fail('invalid_argument', `cannot encode a ${typeof v}`);
    }
  }

  private object(o: object, kind: number, depth: number, allowToJSON: boolean): void {
    switch (kind) {
      case K_ARRAY:
        this.array(o as unknown[], depth);
        return;
      case K_PLAIN:
        this.plainMap(o as Record<string, unknown>, depth);
        return;
      case K_VIEW:
        this.arrayBufferView(o as ArrayBufferView);
        return;
      case K_BUFFER:
        this.binary(bufferBytes(o));
        return;
      case K_DATE:
        this.timestampMs(dateTime(o));
        return;
      case K_MAP:
      case K_PROXY_MAP:
        this.mapObject(o as Map<unknown, unknown>, kind, depth);
        return;
      case K_TIMESTAMP:
        this.timestamp(o as Timestamp);
        return;
      case K_BTOON_DATE:
        this.btoonDate(o as BtoonDate);
        return;
      case K_BTOON_DATETIME:
        this.btoonDateTime(o as BtoonDateTime);
        return;
      case K_EXT:
        this.ext(o as Ext);
        return;
      case K_TOJSON:
        // Like JSON.stringify, toJSON() is called once per value: a result that has its own
        // toJSON() is encoded by its own enumerable properties.
        if (allowToJSON) this.resolved(callToJSON(o), depth);
        else this.plainMap(o as Record<string, unknown>, depth);
        return;
      case K_BOXED:
        this.any(unbox(o), depth, allowToJSON);
        return;
      default: // K_OBJECT
        this.plainMap(o as Record<string, unknown>, depth);
    }
  }

  // --- scalars -------------------------------------------------------------------

  private number(v: number): void {
    // -0 is kept as a float so that its sign survives (SPEC §2).
    if (Number.isSafeInteger(v) && (v !== 0 || 1 / v > 0)) {
      this.int(v);
      return;
    }
    this.ensure(9);
    const p = this.pos;
    this.buf[p] = 0xcb;
    if (v !== v) {
      this.view.setUint32(p + 1, 0x7ff80000);
      this.view.setUint32(p + 5, 0);
    } else {
      this.view.setFloat64(p + 1, v);
    }
    this.pos = p + 9;
  }

  /** Smallest integer format for a safe integer (SPEC §4.1). */
  private int(v: number): void {
    this.ensure(9);
    const buf = this.buf;
    const p = this.pos;
    if (v >= 0) {
      if (v < 0x80) {
        buf[p] = v;
        this.pos = p + 1;
      } else if (v < 0x100) {
        buf[p] = 0xcc;
        buf[p + 1] = v;
        this.pos = p + 2;
      } else if (v < 0x10000) {
        buf[p] = 0xcd;
        this.view.setUint16(p + 1, v);
        this.pos = p + 3;
      } else if (v < TWO_32) {
        buf[p] = 0xce;
        this.view.setUint32(p + 1, v);
        this.pos = p + 5;
      } else {
        buf[p] = 0xcf;
        this.view.setUint32(p + 1, Math.floor(v / TWO_32));
        this.view.setUint32(p + 5, v >>> 0);
        this.pos = p + 9;
      }
    } else if (v >= -32) {
      buf[p] = v & 0xff;
      this.pos = p + 1;
    } else if (v >= -0x80) {
      buf[p] = 0xd0;
      buf[p + 1] = v & 0xff;
      this.pos = p + 2;
    } else if (v >= -0x8000) {
      buf[p] = 0xd1;
      this.view.setInt16(p + 1, v);
      this.pos = p + 3;
    } else if (v >= -0x80000000) {
      buf[p] = 0xd2;
      this.view.setInt32(p + 1, v);
      this.pos = p + 5;
    } else {
      buf[p] = 0xd3;
      this.view.setInt32(p + 1, Math.floor(v / TWO_32));
      this.view.setUint32(p + 5, v >>> 0);
      this.pos = p + 9;
    }
  }

  private bigint(v: bigint): void {
    if (v >= -0x80000000n && v <= 0xffffffffn) {
      this.int(Number(v));
      return;
    }
    if (v >= 0n ? v <= UINT64_MAX : v >= INT64_MIN) {
      this.ensure(9);
      const p = this.pos;
      if (v >= 0n) {
        this.buf[p] = 0xcf;
        this.view.setBigUint64(p + 1, v);
      } else {
        this.buf[p] = 0xd3;
        this.view.setBigInt64(p + 1, v);
      }
      this.pos = p + 9;
      return;
    }
    const b = bigintBytes(v);
    this.extHeader(EXT_BIGINT, b.length);
    this.bytes(b);
  }

  private string(s: string): void {
    const len = s.length;
    if (len < 32) {
      // Short strings: optimistic ASCII pass straight into a fixstr.
      this.ensure(2 + len * 3);
      const buf = this.buf;
      const start = this.pos;
      let p = start + 1;
      let i = 0;
      for (; i < len; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x80) break;
        buf[p++] = c;
      }
      if (i === len) {
        buf[start] = 0xa0 | len;
        this.pos = p;
        return;
      }
      const n = utf8Length(s);
      if (n <= 31) {
        buf[start] = 0xa0 | n;
        this.pos = start + 1;
      } else {
        buf[start] = 0xd9;
        buf[start + 1] = n;
        this.pos = start + 2;
      }
      this.utf8(s);
      return;
    }
    if (!isWellFormed(s)) throw loneSurrogateError();
    const max = len * 3;
    const hdr = max <= 0xff ? 2 : max <= 0xffff ? 3 : 5;
    this.ensure(hdr + max);
    const start = this.pos;
    const { written } = textEncoder.encodeInto(s, this.buf.subarray(start + hdr, start + hdr + max));
    const n = written;
    if (n > 0xffffffff) throw fail('size_limit', 'string longer than 2^32-1 bytes');
    const need = n <= 31 ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5;
    if (need !== hdr) this.buf.copyWithin(start + need, start + hdr, start + hdr + n);
    this.strHeaderAt(start, n, need);
    this.pos = start + need + n;
  }

  private strHeaderAt(p: number, n: number, size: number): void {
    const buf = this.buf;
    if (size === 1) {
      buf[p] = 0xa0 | n;
    } else if (size === 2) {
      buf[p] = 0xd9;
      buf[p + 1] = n;
    } else if (size === 3) {
      buf[p] = 0xda;
      this.view.setUint16(p + 1, n);
    } else {
      buf[p] = 0xdb;
      this.view.setUint32(p + 1, n);
    }
  }

  /** Writes the UTF-8 bytes of a well-formed string; the caller reserved the space. */
  private utf8(s: string): void {
    const buf = this.buf;
    let p = this.pos;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        buf[p++] = c;
      } else if (c < 0x800) {
        buf[p++] = 0xc0 | (c >> 6);
        buf[p++] = 0x80 | (c & 0x3f);
      } else if (c < 0xd800 || c > 0xdfff) {
        buf[p++] = 0xe0 | (c >> 12);
        buf[p++] = 0x80 | ((c >> 6) & 0x3f);
        buf[p++] = 0x80 | (c & 0x3f);
      } else {
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
        buf[p++] = 0xf0 | (c >> 18);
        buf[p++] = 0x80 | ((c >> 12) & 0x3f);
        buf[p++] = 0x80 | ((c >> 6) & 0x3f);
        buf[p++] = 0x80 | (c & 0x3f);
      }
    }
    this.pos = p;
  }

  /** Raw UTF-8 bytes of a string whose exact byte length `n` is known. */
  private utf8Exact(s: string, n: number): void {
    this.ensure(n);
    if (n < 64) {
      this.utf8(s);
    } else {
      textEncoder.encodeInto(s, this.buf.subarray(this.pos, this.pos + n));
      this.pos += n;
    }
  }

  private binary(b: Uint8Array): void {
    const n = b.length;
    this.ensure(5);
    const p = this.pos;
    if (n <= 0xff) {
      this.buf[p] = 0xc4;
      this.buf[p + 1] = n;
      this.pos = p + 2;
    } else if (n <= 0xffff) {
      this.buf[p] = 0xc5;
      this.view.setUint16(p + 1, n);
      this.pos = p + 3;
    } else if (n <= 0xffffffff) {
      this.buf[p] = 0xc6;
      this.view.setUint32(p + 1, n);
      this.pos = p + 5;
    } else {
      throw fail('size_limit', 'binary longer than 2^32-1 bytes');
    }
    this.bytes(b);
  }

  private arrayBufferView(v: ArrayBufferView): void {
    const tag = typedArrayType(v);
    const raw = viewBytes(v);
    if (tag === 'Float32Array' || tag === 'Float64Array') {
      // SPEC §5.5: little-endian payload, NaN bits untouched.
      const n = raw.length;
      this.extHeader(tag === 'Float32Array' ? EXT_F32_VECTOR : EXT_F64_VECTOR, n);
      this.ensure(n);
      if (LITTLE_ENDIAN) {
        this.buf.set(raw, this.pos);
      } else {
        const size = tag === 'Float32Array' ? 4 : 8;
        for (let i = 0; i < n; i += size) {
          for (let b = 0; b < size; b++) this.buf[this.pos + i + b] = raw[i + size - 1 - b]!;
        }
      }
      this.pos += n;
      return;
    }
    this.binary(raw);
  }

  private extHeader(type: number, n: number): void {
    this.ensure(6);
    const buf = this.buf;
    const p = this.pos;
    const t = type & 0xff;
    let fixed = 0;
    switch (n) {
      case 1:
        fixed = 0xd4;
        break;
      case 2:
        fixed = 0xd5;
        break;
      case 4:
        fixed = 0xd6;
        break;
      case 8:
        fixed = 0xd7;
        break;
      case 16:
        fixed = 0xd8;
        break;
    }
    if (fixed !== 0) {
      buf[p] = fixed;
      buf[p + 1] = t;
      this.pos = p + 2;
    } else if (n <= 0xff) {
      buf[p] = 0xc7;
      buf[p + 1] = n;
      buf[p + 2] = t;
      this.pos = p + 3;
    } else if (n <= 0xffff) {
      buf[p] = 0xc8;
      this.view.setUint16(p + 1, n);
      buf[p + 3] = t;
      this.pos = p + 4;
    } else if (n <= 0xffffffff) {
      buf[p] = 0xc9;
      this.view.setUint32(p + 1, n);
      buf[p + 5] = t;
      this.pos = p + 6;
    } else {
      throw fail('size_limit', 'extension payload longer than 2^32-1 bytes');
    }
  }

  /**
   * A raw extension, written as given. SPEC §5.7: the ids BTOON defines (-1…-6 and -10) are
   * rejected, because a verbatim payload could be malformed or non-canonical; those types are
   * written from their typed values. Ids reserved for future versions (-7…-9, -11…-128) and
   * application ids (0…127) pass through. The fields are checked here, not only in the `Ext`
   * constructor, because they can be reassigned and an `Ext` may come from another copy of
   * the library.
   */
  private ext(e: Ext): void {
    const type = e.type;
    const data = e.data;
    if (typeof type !== 'number' || !Number.isInteger(type) || type < -128 || type > 127) {
      throw fail('invalid_argument', 'Ext type must be an integer in [-128, 127]');
    }
    if ((type <= EXT_TIMESTAMP && type >= EXT_F64_VECTOR) || type === EXT_TABULAR) {
      throw fail('invalid_argument', `Ext type ${type} is defined by BTOON and can't be written raw (SPEC §5.7); ${TYPED_INSTEAD[-type]}`);
    }
    if (!isUint8Array(data)) throw fail('invalid_argument', 'Ext data must be a Uint8Array');
    const payload = viewBytes(data); // its real bytes: a subclass can't misreport its length
    this.extHeader(type, payload.length);
    this.bytes(payload);
  }

  // --- date and datetime (SPEC §5.2, §5.3): fixext 8, i64 big-endian ---------------------

  private btoonDate(d: BtoonDate): void {
    const ms = d.epochMilliseconds;
    if (typeof ms !== 'bigint' || ms < INT64_MIN || ms >= INT63) {
      throw fail('invalid_argument', 'BtoonDate epochMilliseconds must be a bigint in the int64 range');
    }
    this.fixext8(EXT_DATE, ms);
  }

  private btoonDateTime(d: BtoonDateTime): void {
    const ns = d.epochNanoseconds;
    if (typeof ns !== 'bigint' || ns < INT64_MIN || ns >= INT63) {
      throw fail('invalid_argument', 'BtoonDateTime epochNanoseconds must be a bigint in the int64 range');
    }
    this.fixext8(EXT_DATETIME, ns);
  }

  private fixext8(type: number, v: bigint): void {
    this.ensure(10);
    const p = this.pos;
    this.buf[p] = 0xd7;
    this.buf[p + 1] = type & 0xff;
    this.view.setBigInt64(p + 2, v);
    this.pos = p + 10;
  }

  // --- timestamps (SPEC §5.1) -------------------------------------------------------

  private timestampMs(ms: number): void {
    const sec = Math.floor(ms / 1000);
    this.timestampParts(sec, (ms - sec * 1000) * 1e6);
  }

  private timestamp(t: Timestamp): void {
    const sec = t.seconds;
    const ns = t.nanoseconds;
    const off = t.offsetMinutes;
    if (typeof sec !== 'bigint' || sec < INT64_MIN || sec >= INT63) {
      throw fail('invalid_argument', 'Timestamp seconds must be a bigint in the int64 range');
    }
    if (typeof ns !== 'number' || !Number.isInteger(ns) || ns < 0 || ns >= NANOS_PER_SECOND) {
      throw fail('invalid_argument', 'Timestamp nanoseconds must be an integer in [0, 999999999]');
    }
    if (off !== undefined) {
      if (typeof off !== 'number' || !Number.isInteger(off) || off < -MAX_OFFSET_MINUTES || off > MAX_OFFSET_MINUTES) {
        throw fail('invalid_argument', 'Timestamp offsetMinutes must be an integer in [-1080, 1080]');
      }
      this.ensure(17);
      const p = this.pos;
      this.buf[p] = 0xc7;
      this.buf[p + 1] = 14;
      this.buf[p + 2] = 0xff;
      this.view.setUint32(p + 3, ns);
      this.view.setBigInt64(p + 7, sec);
      this.view.setInt16(p + 15, off);
      this.pos = p + 17;
      return;
    }
    if (sec >= 0n && sec < 17179869184n) {
      this.timestampParts(Number(sec), ns);
      return;
    }
    this.ensure(15);
    const p = this.pos;
    this.buf[p] = 0xc7;
    this.buf[p + 1] = 12;
    this.buf[p + 2] = 0xff;
    this.view.setUint32(p + 3, ns);
    this.view.setBigInt64(p + 7, sec);
    this.pos = p + 15;
  }

  /** MessagePack timestamp selection for a UTC instant; `sec` is a safe integer. */
  private timestampParts(sec: number, ns: number): void {
    this.ensure(15);
    const buf = this.buf;
    const p = this.pos;
    if (sec >= 0 && sec < TWO_34) {
      if (ns === 0 && sec < TWO_32) {
        buf[p] = 0xd6;
        buf[p + 1] = 0xff;
        this.view.setUint32(p + 2, sec);
        this.pos = p + 6;
      } else {
        buf[p] = 0xd7;
        buf[p + 1] = 0xff;
        this.view.setUint32(p + 2, ns * 4 + Math.floor(sec / TWO_32));
        this.view.setUint32(p + 6, sec >>> 0);
        this.pos = p + 10;
      }
      return;
    }
    buf[p] = 0xc7;
    buf[p + 1] = 12;
    buf[p + 2] = 0xff;
    this.view.setUint32(p + 3, ns);
    this.view.setInt32(p + 7, Math.floor(sec / TWO_32));
    this.view.setUint32(p + 11, sec >>> 0);
    this.pos = p + 15;
  }

  // --- containers ------------------------------------------------------------------

  private arrayHeader(n: number): void {
    this.ensure(5);
    const p = this.pos;
    if (n <= 15) {
      this.buf[p] = 0x90 | n;
      this.pos = p + 1;
    } else if (n <= 0xffff) {
      this.buf[p] = 0xdc;
      this.view.setUint16(p + 1, n);
      this.pos = p + 3;
    } else {
      this.buf[p] = 0xdd;
      this.view.setUint32(p + 1, n);
      this.pos = p + 5;
    }
  }

  private mapHeader(n: number): void {
    this.ensure(5);
    const p = this.pos;
    if (n <= 15) {
      this.buf[p] = 0x80 | n;
      this.pos = p + 1;
    } else if (n <= 0xffff) {
      this.buf[p] = 0xde;
      this.view.setUint16(p + 1, n);
      this.pos = p + 3;
    } else {
      this.buf[p] = 0xdf;
      this.view.setUint32(p + 1, n);
      this.pos = p + 5;
    }
  }

  private plainMap(o: Record<string, unknown>, depth: number): void {
    if (depth >= this.maxDepth) throw maxDepthError();
    const keys = Object.keys(o);
    const n = keys.length;
    if (n > 1) keys.sort(compareUtf8);
    this.mapHeader(n);
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      this.string(k);
      this.value(o[k], depth + 1);
    }
  }

  private mapObject(m: Map<unknown, unknown>, kind: number, depth: number): void {
    if (depth >= this.maxDepth) throw maxDepthError();
    const keys = stringKeys(m, kind);
    if (keys === null) throw fail('invalid_argument', 'Map keys must be strings');
    const n = keys.length;
    if (n > 1) keys.sort(compareUtf8);
    this.mapHeader(n);
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      this.string(k);
      this.value(entry(m, kind, k), depth + 1);
    }
  }

  private array(arr: readonly unknown[], depth: number): void {
    if (depth >= this.maxDepth) throw maxDepthError();
    const n = arr.length;
    // Only a Proxy of an array can report another length.
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      throw fail('invalid_argument', 'an array length must be an integer in [0, 2^32-1]');
    }
    let items = arr;
    let resolvedUpTo = 0;
    if (this.autoTabular && n >= 2) {
      const plan = this.planTabular(arr, n);
      if (plan !== null) {
        this.tabular(plan, depth);
        return;
      }
      items = this.items;
      resolvedUpTo = this.resolvedUpTo;
      this.items = [];
    }
    this.arrayHeader(n);
    for (let i = 0; i < n; i++) {
      if (i < resolvedUpTo) this.resolved(items[i], depth + 1);
      else this.value(arr[i], depth + 1);
    }
  }

  /**
   * SPEC §5.6.2: qualification and size rule. Elements with toJSON() are resolved here
   * (once). The plan keeps the rows it checked, and the table is written from those: code
   * that runs while it is written (getters, toJSON()) can't swap or remove a row. When the
   * array is not tabular, `items[0..resolvedUpTo)` holds the elements already resolved so the
   * plain path doesn't call toJSON() twice.
   */
  private planTabular(arr: readonly unknown[], n: number): TabularPlan | null {
    // Both allocated once the first element qualifies (or has toJSON()).
    let rows: unknown[] | null = null;
    let kinds: Uint8Array | null = null;
    let resolvedAny = false;
    let firstKeys: string[] = [];
    let keySet: Set<string> | null = null;
    for (let i = 0; i < n; i++) {
      let row = arr[i];
      let kind = kindOf(row);
      if (kind === K_TOJSON) {
        row = callToJSON(row as object);
        kind = kindOf(row);
        if (kind === K_TOJSON) kind = K_OBJECT; // no second toJSON()
        resolvedAny = true;
      }
      const keys = mapKeys(row, kind);
      let ok = keys !== null;
      if (ok) {
        if (i === 0) {
          firstKeys = keys!;
          ok = firstKeys.length > 0;
        } else if (keys!.length !== firstKeys.length) {
          ok = false;
        } else {
          for (let k = 0; k < keys!.length; k++) {
            if (keys![k] !== firstKeys[k]) {
              if (keySet === null) keySet = new Set(firstKeys);
              for (let j = 0; j < keys!.length; j++) {
                if (!keySet.has(keys![j]!)) {
                  ok = false;
                  break;
                }
              }
              break;
            }
          }
        }
      }
      if (ok || resolvedAny) {
        // Every earlier element qualified, so `rows` exists unless this is the first.
        if (rows === null) rows = new Array<unknown>(n);
        rows[i] = row;
      }
      if (!ok) return this.decline(arr, resolvedAny ? rows : null, i + 1);
      if (kinds === null) kinds = new Uint8Array(n);
      kinds[i] = kind;
    }
    const keys = firstKeys.slice().sort(compareUtf8);
    const c = keys.length;
    const lens = new Array<number>(c);
    let perRow = c <= 15 ? 1 : c <= 0xffff ? 3 : 5;
    let overhead = 18;
    for (let k = 0; k < c; k++) {
      const len = utf8Length(keys[k]!);
      lens[k] = len;
      perRow += (len <= 31 ? 1 : len <= 0xff ? 2 : len <= 0xffff ? 3 : 5) + len;
      overhead += 9 + len;
    }
    // N * perRow > overhead  <=>  perRow > floor(overhead / N)
    if (perRow <= Math.floor(overhead / n)) return this.decline(arr, resolvedAny ? rows : null, n);
    return { rows: rows!, kinds: kinds!, keys, lens };
  }

  private decline(arr: readonly unknown[], resolved: unknown[] | null, upTo: number): null {
    this.items = resolved ?? arr;
    this.resolvedUpTo = resolved === null ? 0 : upTo;
    return null;
  }

  private tabular(plan: TabularPlan, depth: number): void {
    if (depth + 1 >= this.maxDepth) throw maxDepthError();
    const { rows, kinds, keys, lens } = plan;
    const n = rows.length;
    const c = keys.length;
    const start = this.pos;
    this.ensure(6 + 12);
    this.pos += 6; // room for the largest ext header; shrunk below
    const payload = this.pos;
    this.view.setUint32(payload, TABULAR_VERSION);
    this.view.setUint32(payload + 4, c);
    this.view.setUint32(payload + 8, n);
    this.pos += 12;
    for (let k = 0; k < c; k++) {
      this.ensure(4);
      this.view.setUint32(this.pos, lens[k]!);
      this.pos += 4;
      this.utf8Exact(keys[k]!, lens[k]!);
    }
    // Type codes describe the first row; they are read off its cells' encodings below.
    const codes = this.pos;
    this.ensure(c);
    this.pos += c;
    for (let k = 0; k < c; k++) {
      const key = keys[k]!;
      this.ensure(4);
      const lenPos = this.pos;
      this.pos += 4;
      for (let r = 0; r < n; r++) this.value(entry(rows[r], kinds[r]!, key), depth + 2);
      this.buf[codes + k] = typeCodeAt(this.buf, lenPos + 4);
      const colLen = this.pos - lenPos - 4;
      if (colLen > 0xffffffff) throw fail('size_limit', 'tabular column larger than 2^32-1 bytes');
      this.view.setUint32(lenPos, colLen);
    }
    const len = this.pos - payload;
    if (len > 0xffffffff) throw fail('size_limit', 'tabular payload larger than 2^32-1 bytes');
    const hdr = len <= 0xff ? 3 : len <= 0xffff ? 4 : 6;
    if (hdr < 6) {
      this.buf.copyWithin(start + hdr, payload, this.pos);
      this.pos -= 6 - hdr;
    }
    const buf = this.buf;
    if (hdr === 3) {
      buf[start] = 0xc7;
      buf[start + 1] = len;
      buf[start + 2] = EXT_TABULAR & 0xff;
    } else if (hdr === 4) {
      buf[start] = 0xc8;
      this.view.setUint16(start + 1, len);
      buf[start + 3] = EXT_TABULAR & 0xff;
    } else {
      buf[start] = 0xc9;
      this.view.setUint32(start + 1, len);
      buf[start + 5] = EXT_TABULAR & 0xff;
    }
  }
}

let scratch: Uint8Array | null = null;
const SCRATCH_MAX = 1 << 20;

/** Canonical encoding of `value` (no envelopes). */
export function encodeDocument(value: unknown, maxDepth: number, autoTabular: boolean): Uint8Array<ArrayBuffer> {
  // Reuse one scratch buffer across calls; a re-entrant call (from toJSON) gets its own.
  const buf = scratch ?? new Uint8Array(1024);
  scratch = null;
  const enc = new Encoder(buf, maxDepth, autoTabular);
  try {
    enc.value(value, 0);
  } catch (e) {
    if (isStackOverflow(e)) {
      throw fail('max_depth', 'value nests too deeply for the JavaScript call stack', e);
    }
    throw e;
  } finally {
    if (enc.buf.length <= SCRATCH_MAX) scratch = enc.buf;
  }
  return enc.buf.slice(0, enc.pos);
}
