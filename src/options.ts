import { ALGORITHM_NAMES, DEFAULT_MAX_DECOMPRESSED_SIZE, DEFAULT_MAX_DEPTH } from './constants.js';
import { fail } from './errors.js';
import { isWellFormed } from './utf8.js';
import { isUint8Array } from './values.js';

/** Compression algorithms of the envelope (SPEC §6). Only `zlib` is mandatory. */
export type CompressionAlgorithm = 'zlib' | 'lz4' | 'zstd' | 'brotli' | 'snappy';

/**
 * A user-supplied compression codec (see {@link CodecRegistry}). Either function may be
 * synchronous or return a Promise; synchronous `encode`/`decode` accept only synchronous
 * results.
 */
export interface Codec {
  /**
   * Compress a whole document. The output must be the payload format SPEC §6 requires for
   * the algorithm: an RFC 1950 zlib stream, an LZ4 *block* (no frame), a Zstandard frame,
   * a Brotli stream, or raw Snappy.
   */
  compress?(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /**
   * Decompress a payload. `uncompressedSize` is the size declared by the envelope, already
   * checked against `maxDecompressedSize`; implementations must not produce more than that
   * (LZ4 block decoders need it as the output size). The result must be exactly that long.
   */
  decompress?(data: Uint8Array, uncompressedSize: number): Uint8Array | Promise<Uint8Array>;
}

/**
 * Compression codecs supplied by the caller, keyed by algorithm. A codec here takes
 * precedence over the built-in implementations, so this is how to add LZ4 or Snappy, or
 * synchronous zlib compression in browsers (for example with `fflate`).
 */
export type CodecRegistry = { readonly [A in CompressionAlgorithm]?: Codec };

/** Options of `encode` / `encodeAsync`. */
export interface EncodeOptions {
  /** Wrap the document in a compression envelope (SPEC §6). Default `false`. */
  compress?: boolean;
  /** Algorithm used when `compress` is true. Default `'zlib'`. Has no effect unless `compress` is true. */
  compression?: CompressionAlgorithm;
  /** Use the tabular (columnar) encoding where SPEC §5.6.2's size rule says so. Default `true`. */
  autoTabular?: boolean;
  /** Maximum container nesting; deeper or cyclic values throw `max_depth`. Default `128`. */
  maxDepth?: number;
  /** Sign the output with HMAC-SHA256 (SPEC §8). A string is used as its UTF-8 bytes. Must not be empty. */
  hmacKey?: Uint8Array | string;
  /** Caller-supplied compression codecs. */
  codecs?: CodecRegistry;
}

/** Options of `decode` / `decodeAsync`. */
export interface DecodeOptions {
  /**
   * SPEC §7 strict mode. Default `true`. Non-strict mode allows trailing bytes and
   * duplicate keys (last wins) and replaces invalid UTF-8 with U+FFFD; bounds, depth and
   * allocation checks are never relaxed.
   */
  strict?: boolean;
  /** Maximum container nesting; deeper input throws `max_depth`. Default `128`. */
  maxDepth?: number;
  /** Largest accepted `uncompressed_size` of a compression envelope, in bytes. Default 256 MiB. */
  maxDecompressedSize?: number;
  /** Accept compression envelopes. Default `true`; when `false` they throw `invalid_envelope`. */
  autoDecompress?: boolean;
  /** Require a signed envelope and verify it (SPEC §8) before parsing. Must not be empty. */
  hmacKey?: Uint8Array | string;
  /**
   * How timestamp (-1), date (-2) and datetime (-3) values decode. `'date'` (default):
   * `Date` (millisecond precision, offset dropped; instants outside the range of `Date`
   * become `Timestamp`). `'object'`: always {@link Timestamp}, with full precision.
   */
  timestamps?: 'date' | 'object';
  /**
   * `'auto'` (default): integers decode to `number` when they are safe integers and to
   * `bigint` otherwise. `'always'`: integers written with a 64-bit marker (uint64/int64)
   * or as a bigint extension always decode to `bigint`.
   */
  bigint?: 'auto' | 'always';
  /** Caller-supplied compression codecs. */
  codecs?: CodecRegistry;
}

export interface EncodeConfig {
  compress: boolean;
  algorithm: CompressionAlgorithm;
  autoTabular: boolean;
  maxDepth: number;
  hmacKey: Uint8Array | undefined;
  codecs: CodecRegistry | undefined;
}

export interface DecodeConfig {
  strict: boolean;
  maxDepth: number;
  maxDecompressedSize: number;
  autoDecompress: boolean;
  hmacKey: Uint8Array | undefined;
  timestampObjects: boolean;
  bigintAlways: boolean;
  codecs: CodecRegistry | undefined;
}

const DEFAULT_ENCODE: EncodeConfig = Object.freeze({
  compress: false,
  algorithm: 'zlib',
  autoTabular: true,
  maxDepth: DEFAULT_MAX_DEPTH,
  hmacKey: undefined,
  codecs: undefined,
});

const DEFAULT_DECODE: DecodeConfig = Object.freeze({
  strict: true,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxDecompressedSize: DEFAULT_MAX_DECOMPRESSED_SIZE,
  autoDecompress: true,
  hmacKey: undefined,
  timestampObjects: false,
  bigintAlways: false,
  codecs: undefined,
});

function optionsObject(options: unknown, what: string): Record<string, unknown> | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== 'object') throw fail('invalid_argument', `${what} options must be an object`);
  return options as Record<string, unknown>;
}

function bool(o: Record<string, unknown>, name: string, dflt: boolean): boolean {
  const v = o[name];
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') throw fail('invalid_argument', `option ${name} must be a boolean`);
  return v;
}

function count(o: Record<string, unknown>, name: string, dflt: number): number {
  const v = o[name];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw fail('invalid_argument', `option ${name} must be a non-negative integer`);
  }
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, name: string, allowed: readonly T[], dflt: T): T {
  const v = o[name];
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw fail('invalid_argument', `option ${name} must be one of ${allowed.map((a) => `'${a}'`).join(', ')}`);
  }
  return v as T;
}

function hmacKey(o: Record<string, unknown>): Uint8Array | undefined {
  const v = o.hmacKey;
  if (v === undefined) return undefined;
  let key: Uint8Array;
  if (typeof v === 'string') {
    if (!isWellFormed(v)) throw fail('invalid_argument', 'hmacKey string contains a lone surrogate');
    key = new TextEncoder().encode(v);
  } else if (isUint8Array(v)) {
    key = Uint8Array.prototype.slice.call(v); // private copy: immune to later mutation
  } else {
    throw fail('invalid_argument', 'option hmacKey must be a Uint8Array or a string');
  }
  if (key.length === 0) throw fail('invalid_argument', 'option hmacKey must not be empty');
  return key;
}

function codecs(o: Record<string, unknown>): CodecRegistry | undefined {
  const v = o.codecs;
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null) throw fail('invalid_argument', 'option codecs must be an object');
  for (const name of ALGORITHM_NAMES) {
    const c = (v as Record<string, unknown>)[name];
    if (c === undefined) continue;
    if (typeof c !== 'object' || c === null) throw fail('invalid_argument', `codecs.${name} must be an object`);
    for (const fn of ['compress', 'decompress'] as const) {
      const f = (c as Record<string, unknown>)[fn];
      if (f !== undefined && typeof f !== 'function') {
        throw fail('invalid_argument', `codecs.${name}.${fn} must be a function`);
      }
    }
  }
  return v as CodecRegistry;
}

export function encodeConfig(options: EncodeOptions | undefined): EncodeConfig {
  const o = optionsObject(options, 'encode');
  if (o === undefined) return DEFAULT_ENCODE;
  return {
    compress: bool(o, 'compress', false),
    algorithm: oneOf(o, 'compression', ALGORITHM_NAMES, 'zlib'),
    autoTabular: bool(o, 'autoTabular', true),
    maxDepth: count(o, 'maxDepth', DEFAULT_MAX_DEPTH),
    hmacKey: hmacKey(o),
    codecs: codecs(o),
  };
}

export function decodeConfig(options: DecodeOptions | undefined): DecodeConfig {
  const o = optionsObject(options, 'decode');
  if (o === undefined) return DEFAULT_DECODE;
  return {
    strict: bool(o, 'strict', true),
    maxDepth: count(o, 'maxDepth', DEFAULT_MAX_DEPTH),
    maxDecompressedSize: count(o, 'maxDecompressedSize', DEFAULT_MAX_DECOMPRESSED_SIZE),
    autoDecompress: bool(o, 'autoDecompress', true),
    hmacKey: hmacKey(o),
    timestampObjects: oneOf(o, 'timestamps', ['date', 'object'] as const, 'date') === 'object',
    bigintAlways: oneOf(o, 'bigint', ['auto', 'always'] as const, 'auto') === 'always',
    codecs: codecs(o),
  };
}
