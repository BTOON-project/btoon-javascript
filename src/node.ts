/**
 * BTOON for JavaScript and TypeScript — Node.js entry point (also used by Bun). Same API
 * as the portable entry; synchronous compression and signing use `node:zlib` (zlib,
 * Brotli, and Zstandard where Node.js has it) and `node:crypto`.
 *
 * @packageDocumentation
 */
import { decodeAsyncWith, decodeWith, encodeAsyncWith, encodeWith, type BinaryInput } from './core.js';
import type { DecodeOptions, EncodeOptions } from './options.js';
import { nodePlatform } from './platform-node.js';

export { SPEC_VERSION, VERSION } from './constants.js';
export type { BinaryInput } from './core.js';
export { BtoonError, type BtoonErrorCode } from './errors.js';
export type { Codec, CodecRegistry, CompressionAlgorithm, DecodeOptions, EncodeOptions } from './options.js';
export { Ext, Timestamp } from './values.js';

/**
 * Encodes a value as canonical BTOON (SPEC §4): identical values produce identical bytes
 * in every conforming implementation.
 *
 * Accepted values: `null`/`undefined` (nil), booleans, numbers (safe integers as integers,
 * everything else — including `-0`, `NaN` and integral values beyond ±2^53 — as float64),
 * `bigint`, strings (must not contain lone surrogates), `Uint8Array`/`ArrayBuffer`/other
 * typed arrays and `DataView` (binary), `Float32Array`/`Float64Array` (float vectors),
 * arrays, plain objects and `Map`s with string keys (maps, keys sorted by UTF-8 bytes),
 * `Date` and {@link Timestamp} (timestamps), and {@link Ext}. Any other object is encoded
 * the way `JSON.stringify` sees it: the result of its `toJSON()` method if it has one
 * (called once), otherwise a map of its own enumerable string-keyed properties; `Number`,
 * `String`, `Boolean` and `BigInt` wrapper objects are unwrapped. Functions and symbols are
 * rejected. Arrays of uniform objects use the tabular encoding when it is smaller.
 *
 * With `compress` or `hmacKey`, the document is wrapped in a compression and/or signed
 * envelope, layered as sign(compress(document)).
 *
 * @throws {BtoonError} `invalid_argument` for functions, symbols or invalid options, `max_depth`
 *   for values nested deeper than `maxDepth` (including cycles), `invalid_utf8` for strings
 *   with lone surrogates, `unsupported_compression` if the algorithm has no synchronous
 *   implementation here (see `encodeAsync` and `options.codecs`).
 */
export function encode(value: unknown, options?: EncodeOptions): Uint8Array<ArrayBuffer> {
  return encodeWith(value, options, nodePlatform);
}

/**
 * Decodes one BTOON document, enforcing SPEC §7: bounds-checked reads, a nesting limit,
 * no allocation beyond what the input justifies, strict UTF-8, unique map keys and no
 * trailing bytes. Compression envelopes are decompressed (with the output capped at the
 * declared size and `maxDecompressedSize`); with `hmacKey` the signature is verified before
 * anything is parsed.
 *
 * Maps decode to plain objects. A `"__proto__"` key becomes an own property (as with
 * `JSON.parse`); it never changes an object's prototype.
 *
 * @throws {BtoonError} with the SPEC §7 error code describing the problem.
 */
export function decode(data: BinaryInput, options?: DecodeOptions): unknown {
  return decodeWith(data, options, nodePlatform);
}

/**
 * Like {@link encode}, but compresses with `CompressionStream` (when the runtime supports
 * the algorithm) and signs with WebCrypto, falling back to the synchronous implementations.
 * Rejects with a {@link BtoonError}.
 */
export function encodeAsync(value: unknown, options?: EncodeOptions): Promise<Uint8Array<ArrayBuffer>> {
  return encodeAsyncWith(value, options, nodePlatform);
}

/**
 * Like {@link decode}, but decompresses with `DecompressionStream` (when the runtime
 * supports the algorithm) and verifies signatures with `crypto.subtle.verify`, falling back
 * to the synchronous implementations. The input is copied first, so the caller may reuse
 * its buffer immediately. Rejects with a {@link BtoonError}.
 */
export function decodeAsync(data: BinaryInput, options?: DecodeOptions): Promise<unknown> {
  return decodeAsyncWith(data, options, nodePlatform);
}
