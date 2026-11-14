import {
  DATE_BRAND,
  DATETIME_BRAND,
  EXT_BRAND,
  MAX_DATE_MS,
  MAX_OFFSET_MINUTES,
  NANOS_PER_SECOND,
  TIMESTAMP_BRAND,
} from './constants.js';
import { fail } from './errors.js';

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;

/**
 * The type of a typed array of any realm ('Uint8Array', 'Float32Array', …), from the
 * intrinsic getter, which a subclass can't override; undefined for anything else.
 */
export function typedArrayType(v: unknown): string | undefined {
  return typedArrayTagGetter.call(v) as string | undefined;
}

/** True for a Uint8Array from any realm (including Node.js Buffers). */
export function isUint8Array(v: unknown): v is Uint8Array {
  return typedArrayType(v) === 'Uint8Array';
}

// The intrinsic accessors, which work on views of any realm and which a subclass can't
// override: the bytes are read where they really are.
const accessor = (proto: object, name: string): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(proto, name)!.get as (this: unknown) => unknown;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY = [accessor(typedArrayPrototype, 'buffer'), accessor(typedArrayPrototype, 'byteOffset'), accessor(typedArrayPrototype, 'byteLength')] as const;
const DATA_VIEW = [accessor(DataView.prototype, 'buffer'), accessor(DataView.prototype, 'byteOffset'), accessor(DataView.prototype, 'byteLength')] as const;

/** The buffer a view (typed array or DataView, of any realm) is over. */
export function viewBuffer(v: ArrayBufferView): ArrayBufferLike {
  return (typedArrayType(v) !== undefined ? TYPED_ARRAY : DATA_VIEW)[0].call(v) as ArrayBufferLike;
}

/** The bytes a view covers, as a Uint8Array over the same memory; none if its buffer is detached. */
export function viewBytes(v: ArrayBufferView): Uint8Array {
  const [buffer, offset, length] = typedArrayType(v) !== undefined ? TYPED_ARRAY : DATA_VIEW;
  let start: number;
  let size: number;
  try {
    start = offset.call(v) as number;
    size = length.call(v) as number;
  } catch {
    return new Uint8Array(0); // a DataView of a detached buffer
  }
  return bufferBytes(buffer.call(v), start, size);
}

/** A Uint8Array over an ArrayBuffer or SharedArrayBuffer; empty if the buffer is detached. */
export function bufferBytes(buffer: unknown, offset = 0, length?: number): Uint8Array {
  try {
    return new Uint8Array(buffer as ArrayBuffer, offset, length);
  } catch {
    return new Uint8Array(0); // a detached buffer holds no bytes
  }
}

function branded(v: unknown, brand: symbol): boolean {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[brand] === true;
}

/** `[q, r]` with `a = q·b + r` and `0 ≤ r < b`: division rounded toward −∞. */
function floorDiv(a: bigint, b: bigint): [bigint, bigint] {
  let q = a / b;
  let r = a % b;
  if (r < 0n) {
    r += b;
    q -= 1n;
  }
  return [q, r];
}

/** A bigint, or a safe-integer number, in the int64 range; `invalid_argument` otherwise. */
function int64(v: unknown, what: string): bigint {
  let n: bigint;
  if (typeof v === 'bigint') {
    n = v;
  } else if (typeof v === 'number' && Number.isSafeInteger(v)) {
    n = BigInt(v);
  } else {
    throw fail('invalid_argument', `${what} must be a bigint or a safe integer`);
  }
  if (n < INT64_MIN || n > INT64_MAX) throw fail('invalid_argument', `${what} must fit in a signed 64-bit integer`);
  return n;
}

/**
 * A generic MessagePack extension value: a signed 8-bit type id and an opaque payload.
 *
 * Decoding returns `Ext` for every extension id BTOON does not define: application ids
 * 0…127, and the ids reserved for future BTOON versions (-7…-9, -11…-128). Encoding writes
 * those verbatim with the smallest header. The ids BTOON defines (-1…-6 and -10) can't be
 * written raw (SPEC §5.7): encoding such an `Ext` throws `invalid_argument`, because a
 * verbatim payload could be malformed or non-canonical. Those types are written from their
 * typed values (`Date`/{@link Timestamp}, {@link BtoonDate}, {@link BtoonDateTime}, `bigint`,
 * `Float32Array`/`Float64Array`, arrays of objects). The constructor itself accepts them,
 * like the other BTOON libraries.
 *
 * `instanceof Ext` holds for instances from every copy of this library and from the native
 * `btoon` package (a brand check).
 */
export class Ext {
  /** Extension type id, an integer in [-128, 127]. */
  readonly type: number;
  /** The payload bytes (not copied by the constructor). */
  readonly data: Uint8Array;

  /**
   * @param type An integer in [-128, 127].
   * @param data The payload, a `Uint8Array` (a Node.js `Buffer` is one).
   * @throws {BtoonError} `invalid_argument` for a type out of range, or data that isn't a `Uint8Array`.
   */
  constructor(type: number, data: Uint8Array) {
    if (typeof type !== 'number' || !Number.isInteger(type) || type < -128 || type > 127) {
      throw fail('invalid_argument', `Ext type must be an integer in [-128, 127], got ${String(type)}`);
    }
    if (!isUint8Array(data)) {
      throw fail('invalid_argument', 'Ext data must be a Uint8Array');
    }
    this.type = type;
    this.data = data;
  }

  static [Symbol.hasInstance](value: unknown): value is Ext {
    return this === Ext ? isExt(value) : ordinaryHasInstance.call(this, value);
  }
}
Object.defineProperty(Ext.prototype, EXT_BRAND, { value: true });

/**
 * A BTOON timestamp (extension -1): an instant with nanosecond precision and an optional
 * UTC offset.
 *
 * `seconds` and `nanoseconds` always describe the instant in UTC. `offsetMinutes` is
 * presentation metadata ("local time is UTC + offset") and is encoded only when present.
 * Decoding returns `Timestamp` objects when `timestamps: 'object'` is set, and for
 * instants outside the range of `Date`.
 *
 * {@link BtoonDate} (extension -2) and {@link BtoonDateTime} (-3) are subclasses: code that
 * checks `instanceof Timestamp` or reads `seconds`/`nanoseconds` handles all three.
 * `instanceof` holds for instances from every copy of this library and from the native
 * `btoon` package (a brand check).
 */
export class Timestamp {
  /** Whole seconds since the Unix epoch (UTC), in the int64 range. */
  readonly seconds: bigint;
  /** Nanoseconds within the second, in [0, 999 999 999]. */
  readonly nanoseconds: number;
  /** UTC offset in minutes, in [-1080, 1080], or `undefined` for a plain UTC timestamp. */
  readonly offsetMinutes?: number;

  /**
   * @param seconds Seconds since the Unix epoch; a `bigint`, or a `number` that is a safe integer.
   * @param nanoseconds Nanoseconds within the second, an integer in [0, 1e9). Default 0.
   * @param offsetMinutes Optional UTC offset in minutes, an integer in [-1080, 1080].
   * @throws {BtoonError} `invalid_argument` if a field is out of range.
   */
  constructor(seconds: bigint | number, nanoseconds: number = 0, offsetMinutes?: number) {
    const s = int64(seconds, 'Timestamp seconds');
    if (
      typeof nanoseconds !== 'number' ||
      !Number.isInteger(nanoseconds) ||
      nanoseconds < 0 ||
      nanoseconds >= NANOS_PER_SECOND
    ) {
      throw fail('invalid_argument', 'Timestamp nanoseconds must be an integer in [0, 999999999]');
    }
    if (
      offsetMinutes !== undefined &&
      (typeof offsetMinutes !== 'number' ||
        !Number.isInteger(offsetMinutes) ||
        offsetMinutes < -MAX_OFFSET_MINUTES ||
        offsetMinutes > MAX_OFFSET_MINUTES)
    ) {
      throw fail('invalid_argument', 'Timestamp offsetMinutes must be an integer in [-1080, 1080]');
    }
    this.seconds = s;
    this.nanoseconds = nanoseconds;
    this.offsetMinutes = offsetMinutes;
  }

  /**
   * The instant as a `Date`. Sub-millisecond nanoseconds are truncated toward the past and
   * the offset is dropped (a `Date` has no offset).
   * @throws {BtoonError} `invalid_argument` if the instant is outside the range of `Date`.
   */
  toDate(): Date {
    const ms = this.seconds * 1000n + BigInt(Math.floor(this.nanoseconds / 1e6));
    if (ms > BigInt(MAX_DATE_MS) || ms < -BigInt(MAX_DATE_MS)) {
      throw fail('invalid_argument', 'Timestamp is outside the range of Date');
    }
    return new Date(Number(ms));
  }

  /**
   * The UTC timestamp of a `Date` (millisecond precision, no offset).
   * @throws {BtoonError} `invalid_argument` for an invalid `Date`.
   */
  static fromDate(date: Date): Timestamp {
    const ms = dateTime(date, 'cannot convert an invalid Date');
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(BigInt(seconds), (ms - seconds * 1000) * 1e6);
  }

  static [Symbol.hasInstance](value: unknown): value is Timestamp {
    return this === Timestamp ? isTimestamp(value) : ordinaryHasInstance.call(this, value);
  }
}
Object.defineProperty(Timestamp.prototype, TIMESTAMP_BRAND, { value: true });

/**
 * The UTC instant of a Timestamp (from any copy of the library), for conversion into a date
 * or datetime, which have no offset. The fields are checked again: they are writable.
 */
function utcInstant(ts: unknown, target: string): { seconds: bigint; nanoseconds: number } {
  if (!isTimestamp(ts)) throw fail('invalid_argument', `${target}.fromTimestamp() expects a Timestamp`);
  const { seconds, nanoseconds, offsetMinutes } = ts;
  if (typeof seconds !== 'bigint' || seconds < INT64_MIN || seconds > INT64_MAX) {
    throw fail('invalid_argument', 'Timestamp seconds must be a bigint in the int64 range');
  }
  if (typeof nanoseconds !== 'number' || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= NANOS_PER_SECOND) {
    throw fail('invalid_argument', 'Timestamp nanoseconds must be an integer in [0, 999999999]');
  }
  if (offsetMinutes !== undefined) {
    throw fail('invalid_argument', `a Timestamp with a UTC offset can't be a ${target}, which has none`);
  }
  return { seconds, nanoseconds };
}

/**
 * A BTOON date (extension -2): milliseconds since the Unix epoch, UTC, with no offset.
 *
 * `epochMilliseconds` is the exact value on the wire. The inherited `seconds` and
 * `nanoseconds` describe the same instant (`seconds` = ⌊ms / 1000⌋), and `offsetMinutes` is
 * always `undefined`. Decoding returns `BtoonDate` for a date with `timestamps: 'object'`, and
 * with the default `'date'` for one outside the range of `Date`; encoding writes it back as a
 * date. A `Date` still encodes as a timestamp (-1).
 */
export class BtoonDate extends Timestamp {
  /** Milliseconds since the Unix epoch (UTC), in the int64 range. */
  readonly epochMilliseconds: bigint;

  /**
   * @param epochMilliseconds Milliseconds since the Unix epoch; a `bigint` in the int64 range,
   *   or a `number` that is a safe integer.
   * @throws {BtoonError} `invalid_argument` for anything else.
   */
  constructor(epochMilliseconds: bigint | number) {
    const ms = int64(epochMilliseconds, 'BtoonDate epochMilliseconds');
    const [seconds, millis] = floorDiv(ms, 1000n);
    super(seconds, Number(millis) * 1_000_000);
    this.epochMilliseconds = ms;
  }

  /**
   * The date of a `Date` (from any realm).
   * @throws {BtoonError} `invalid_argument` for an invalid `Date`.
   */
  static override fromDate(date: Date): BtoonDate {
    return new BtoonDate(dateTime(date, 'cannot convert an invalid Date'));
  }

  /**
   * The date of a {@link Timestamp}, floored to the millisecond.
   * @throws {BtoonError} `invalid_argument` for a Timestamp with a UTC offset (a date has
   *   none), or one outside the int64 range of milliseconds.
   */
  static fromTimestamp(ts: Timestamp): BtoonDate {
    const { seconds, nanoseconds } = utcInstant(ts, 'BtoonDate');
    const ms = seconds * 1000n + BigInt(Math.floor(nanoseconds / 1e6));
    if (ms < INT64_MIN || ms > INT64_MAX) throw fail('invalid_argument', 'Timestamp is outside the range of BtoonDate');
    return new BtoonDate(ms);
  }

  static override [Symbol.hasInstance](value: unknown): value is BtoonDate {
    return this === BtoonDate ? isBtoonDate(value) : ordinaryHasInstance.call(this, value);
  }
}
Object.defineProperty(BtoonDate.prototype, DATE_BRAND, { value: true });

/**
 * A BTOON datetime (extension -3): nanoseconds since the Unix epoch, UTC, with no offset.
 * The int64 range covers 1677-09-21 to 2262-04-11.
 *
 * `epochNanoseconds` is the exact value on the wire. The inherited `seconds` and
 * `nanoseconds` describe the same instant, and `offsetMinutes` is always `undefined`.
 * Decoding returns `BtoonDateTime` for a datetime with `timestamps: 'object'`; encoding writes
 * it back as a datetime.
 */
export class BtoonDateTime extends Timestamp {
  /** Nanoseconds since the Unix epoch (UTC), in the int64 range. */
  readonly epochNanoseconds: bigint;

  /**
   * @param epochNanoseconds Nanoseconds since the Unix epoch; a `bigint` in the int64 range,
   *   or a `number` that is a safe integer.
   * @throws {BtoonError} `invalid_argument` for anything else.
   */
  constructor(epochNanoseconds: bigint | number) {
    const ns = int64(epochNanoseconds, 'BtoonDateTime epochNanoseconds');
    const [seconds, nanos] = floorDiv(ns, 1_000_000_000n);
    super(seconds, Number(nanos));
    this.epochNanoseconds = ns;
  }

  /**
   * The datetime of a `Date` (from any realm).
   * @throws {BtoonError} `invalid_argument` for an invalid `Date`, or one outside the range of
   *   a datetime (1677-09-21 to 2262-04-11).
   */
  static override fromDate(date: Date): BtoonDateTime {
    const ns = BigInt(dateTime(date, 'cannot convert an invalid Date')) * 1_000_000n;
    if (ns < INT64_MIN || ns > INT64_MAX) throw fail('invalid_argument', 'Date is outside the range of BtoonDateTime');
    return new BtoonDateTime(ns);
  }

  /**
   * The datetime of a {@link Timestamp}, exactly.
   * @throws {BtoonError} `invalid_argument` for a Timestamp with a UTC offset (a datetime has
   *   none), or one outside the int64 range of nanoseconds.
   */
  static fromTimestamp(ts: Timestamp): BtoonDateTime {
    const { seconds, nanoseconds } = utcInstant(ts, 'BtoonDateTime');
    const ns = seconds * 1_000_000_000n + BigInt(nanoseconds);
    if (ns < INT64_MIN || ns > INT64_MAX) throw fail('invalid_argument', 'Timestamp is outside the range of BtoonDateTime');
    return new BtoonDateTime(ns);
  }

  static override [Symbol.hasInstance](value: unknown): value is BtoonDateTime {
    return this === BtoonDateTime ? isBtoonDateTime(value) : ordinaryHasInstance.call(this, value);
  }
}
Object.defineProperty(BtoonDateTime.prototype, DATETIME_BRAND, { value: true });

/** Milliseconds of a Date (from any realm); throws for an invalid Date. */
export function dateTime(date: unknown, invalid: string = 'cannot encode an invalid Date'): number {
  let ms: number;
  try {
    ms = Date.prototype.getTime.call(date);
  } catch {
    throw fail('invalid_argument', 'expected a Date');
  }
  if (!Number.isFinite(ms)) throw fail('invalid_argument', invalid);
  return ms;
}

export function isExt(v: unknown): v is Ext {
  return branded(v, EXT_BRAND);
}

export function isTimestamp(v: unknown): v is Timestamp {
  return branded(v, TIMESTAMP_BRAND);
}

export function isBtoonDate(v: unknown): v is BtoonDate {
  return branded(v, DATE_BRAND);
}

export function isBtoonDateTime(v: unknown): v is BtoonDateTime {
  return branded(v, DATETIME_BRAND);
}
