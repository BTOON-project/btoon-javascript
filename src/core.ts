// encode/decode with the compression (SPEC §6) and signed (SPEC §8) envelopes, layered as
// sign(compress(encode(value))). The entry points bind these to a Platform: the set of
// synchronous codecs available in that environment.
import {
  ALGORITHM_IDS,
  ALGORITHM_NAMES,
  COMPRESSION_HEADER_SIZE,
  MIN_COMPRESSION_SIZE,
  SIGNED_HEADER_SIZE,
} from './constants.js';
import { decodeDocument, plainBytes } from './decode.js';
import { encodeDocument } from './encode.js';
import { BtoonError, fail } from './errors.js';
import {
  decodeConfig,
  encodeConfig,
  type CodecRegistry,
  type CompressionAlgorithm,
  type DecodeConfig,
  type DecodeOptions,
  type EncodeOptions,
} from './options.js';
import { bufferBytes, isUint8Array, viewBuffer, viewBytes } from './values.js';
import {
  mayDecompressAsync,
  subtle,
  trustedDecompressionFormat,
  webCompress,
  webDecompress,
  webFormat,
  webHmacSign,
  webHmacVerify,
} from './web.js';

/** Building blocks of one environment: its synchronous codecs and HMAC, and non-blocking decompressors. */
export interface Platform {
  /** Decompressors; `size` is the declared uncompressed size (already checked against the limit). */
  readonly decompress: Readonly<Partial<Record<CompressionAlgorithm, (data: Uint8Array, size: number) => Uint8Array>>>;
  /**
   * Non-blocking forms of `decompress` that reach the same verdict (node:zlib on the thread
   * pool). decodeAsync prefers them.
   */
  readonly decompressAsync?: Readonly<Partial<Record<CompressionAlgorithm, (data: Uint8Array, size: number) => Promise<Uint8Array>>>>;
  readonly compress: Readonly<Partial<Record<CompressionAlgorithm, (data: Uint8Array) => Uint8Array>>>;
  hmac(key: Uint8Array, parts: readonly Uint8Array[]): Uint8Array;
  equal(a: Uint8Array, b: Uint8Array): boolean;
}

/** Input accepted by `decode`. */
export type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;

const COMPRESSED_MAGIC = [0x42, 0x54, 0x4f, 0x4e]; // "BTON"
const SIGNED_MAGIC = [0x42, 0x54, 0x53, 0x47]; // "BTSG"
const SIGNED_HEADER = new Uint8Array([0x42, 0x54, 0x53, 0x47, 1, 1, 0, 0]);

function hasMagic(b: Uint8Array, magic: readonly number[]): boolean {
  return b.length >= 4 && b[0] === magic[0] && b[1] === magic[1] && b[2] === magic[2] && b[3] === magic[3];
}

const getter = (proto: object, name: string): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(proto, name)!.get as (this: unknown) => unknown;
const arrayBufferLength = getter(ArrayBuffer.prototype, 'byteLength');
const sharedArrayBufferLength = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'byteLength') : undefined;

/** True if `v` is an ArrayBuffer (`shared` false) or a SharedArrayBuffer (`shared` true) of any realm. */
function isBuffer(v: unknown, shared: boolean): boolean {
  const length = shared ? sharedArrayBufferLength : arrayBufferLength;
  if (length === undefined) return false;
  try {
    length.call(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes of decode's input. Input in shared memory is copied once, so that a signature is
 * verified on the bytes that are then parsed (another thread can change shared memory in
 * between), and because browsers' TextDecoder refuses views of a SharedArrayBuffer.
 */
function inputBytes(data: unknown): Uint8Array {
  let bytes: Uint8Array;
  let buffer: unknown = data;
  if (ArrayBuffer.isView(data)) {
    bytes = viewBytes(data);
    buffer = viewBuffer(data);
  } else if (isBuffer(data, false) || isBuffer(data, true)) {
    bytes = bufferBytes(data);
  } else {
    throw fail('invalid_argument', 'decode() expects a Uint8Array, ArrayBuffer or other ArrayBufferView');
  }
  return isBuffer(buffer, true) ? bytes.slice() : bytes;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

// --- compression envelope -----------------------------------------------------------------

function envelopeIfSmaller(raw: Uint8Array<ArrayBuffer>, payload: Uint8Array, alg: CompressionAlgorithm): Uint8Array<ArrayBuffer> {
  // SPEC §6: only when it saves at least 5%, i.e. 20 × envelope_size ≤ 19 × input_size.
  if (20 * (COMPRESSION_HEADER_SIZE + payload.length) > 19 * raw.length) return raw;
  const out = new Uint8Array(COMPRESSION_HEADER_SIZE + payload.length);
  out.set(COMPRESSED_MAGIC, 0);
  out[4] = 1;
  out[5] = ALGORITHM_IDS[alg];
  const view = new DataView(out.buffer);
  view.setUint32(8, payload.length);
  view.setUint32(12, raw.length);
  out.set(payload, COMPRESSION_HEADER_SIZE);
  return out;
}

interface Envelope {
  alg: CompressionAlgorithm;
  payload: Uint8Array;
  size: number;
}

/**
 * Checks the header of a compression envelope in SPEC §6's order (before any decompression),
 * or returns null if the input is not one.
 */
function compressionEnvelope(b: Uint8Array, cfg: DecodeConfig): Envelope | null {
  if (b.length < COMPRESSION_HEADER_SIZE || !hasMagic(b, COMPRESSED_MAGIC)) return null;
  if (!cfg.autoDecompress) throw fail('invalid_envelope', 'input is compressed but autoDecompress is disabled');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[4] !== 1) throw fail('invalid_envelope', `unsupported compression envelope version ${b[4]!}`);
  if (view.getUint16(6) !== 0) throw fail('invalid_envelope', 'compression envelope reserved bytes must be zero');
  if (view.getUint32(8) !== b.length - COMPRESSION_HEADER_SIZE) {
    throw fail('invalid_envelope', 'compressed size does not match the envelope length');
  }
  const size = view.getUint32(12);
  if (size > cfg.maxDecompressedSize) {
    throw fail('size_limit', `declared uncompressed size ${size} exceeds maxDecompressedSize (${cfg.maxDecompressedSize})`);
  }
  const alg = ALGORITHM_NAMES[b[5]!];
  if (alg === undefined) throw fail('unsupported_compression', `unknown compression algorithm id ${b[5]!}`);
  const payload = b.subarray(COMPRESSION_HEADER_SIZE);
  // SPEC §6: a zlib stream must not use a preset dictionary. Checked here, ahead of every
  // decompressor (the pure-JS inflate, node:zlib, or a caller's codec), so they all agree.
  if (alg === 'zlib' && payload.length >= 2 && (payload[1]! & 0x20) !== 0) {
    throw fail('invalid_envelope', 'zlib payload uses a preset dictionary (FDICT), which BTOON does not allow');
  }
  return { alg, payload, size };
}

function checkSize(out: Uint8Array, size: number, alg: string): Uint8Array {
  if (out.length !== size) throw fail('invalid_envelope', `${alg} payload decompressed size does not match the header`);
  return out;
}

function unavailable(alg: CompressionAlgorithm, op: 'compression' | 'decompression', asyncWorks: boolean): Error {
  const fn = op === 'compression' ? 'encodeAsync()' : 'decodeAsync()';
  return fail(
    'unsupported_compression',
    asyncWorks
      ? `${alg} ${op} is not available synchronously in this environment; use ${fn} or pass options.codecs.${alg}`
      : `${alg} ${op} is not available in this environment; pass options.codecs.${alg}`,
  );
}

function codecResult(r: unknown, alg: string, fn: string): Uint8Array {
  if (!isUint8Array(r)) throw fail('invalid_argument', `codecs.${alg}.${fn} must return a Uint8Array`);
  return plainBytes(r);
}

function codecError(e: unknown, alg: string, fn: 'compress' | 'decompress'): BtoonError {
  if (e instanceof BtoonError) return e;
  return fail(fn === 'decompress' ? 'invalid_envelope' : 'invalid_argument', `codecs.${alg}.${fn} failed: ${messageOf(e)}`, e);
}

function callCodecSync(
  codecs: CodecRegistry | undefined,
  alg: CompressionAlgorithm,
  fn: 'compress' | 'decompress',
  args: [Uint8Array] | [Uint8Array, number],
): Uint8Array | undefined {
  const codec = codecs?.[alg];
  const f = codec?.[fn] as ((...a: unknown[]) => unknown) | undefined;
  if (f === undefined) return undefined;
  let r: unknown;
  try {
    r = f.apply(codec, args);
  } catch (e) {
    throw codecError(e, alg, fn);
  }
  if (isThenable(r)) {
    Promise.resolve(r).catch(() => undefined);
    throw fail('invalid_argument', `codecs.${alg}.${fn} returned a Promise; use the async API (encodeAsync/decodeAsync)`);
  }
  return codecResult(r, alg, fn);
}

async function callCodecAsync(
  codecs: CodecRegistry | undefined,
  alg: CompressionAlgorithm,
  fn: 'compress' | 'decompress',
  args: [Uint8Array] | [Uint8Array, number],
): Promise<Uint8Array | undefined> {
  const codec = codecs?.[alg];
  const f = codec?.[fn] as ((...a: unknown[]) => unknown) | undefined;
  if (f === undefined) return undefined;
  let r: unknown;
  try {
    r = await f.apply(codec, args);
  } catch (e) {
    throw codecError(e, alg, fn);
  }
  return codecResult(r, alg, fn);
}

function hasCodec(codecs: CodecRegistry | undefined, alg: CompressionAlgorithm, fn: 'compress' | 'decompress'): boolean {
  return typeof codecs?.[alg]?.[fn] === 'function';
}

// --- signed envelope ------------------------------------------------------------------------

interface Signed {
  header: Uint8Array;
  mac: Uint8Array;
  payload: Uint8Array;
}

function signedEnvelope(b: Uint8Array): Signed {
  if (!hasMagic(b, SIGNED_MAGIC)) throw fail('authentication_failed', 'input is not a signed envelope');
  if (b.length < SIGNED_HEADER_SIZE) throw fail('invalid_envelope', 'signed envelope is truncated');
  if (b[4] !== 1 || b[5] !== 1 || b[6] !== 0 || b[7] !== 0) {
    throw fail('invalid_envelope', 'unsupported signed envelope version or algorithm');
  }
  return { header: b.subarray(0, 8), mac: b.subarray(8, SIGNED_HEADER_SIZE), payload: b.subarray(SIGNED_HEADER_SIZE) };
}

function rejectUnexpectedSignature(b: Uint8Array): void {
  if (b.length >= SIGNED_HEADER_SIZE && hasMagic(b, SIGNED_MAGIC)) {
    throw fail('authentication_failed', 'input is signed but no hmacKey was provided');
  }
}

function assembleSigned(mac: Uint8Array, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SIGNED_HEADER_SIZE + payload.length);
  out.set(SIGNED_HEADER, 0);
  out.set(mac, 8);
  out.set(payload, SIGNED_HEADER_SIZE);
  return out;
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// --- synchronous API ------------------------------------------------------------------------

export function encodeWith(value: unknown, options: EncodeOptions | undefined, platform: Platform): Uint8Array<ArrayBuffer> {
  const cfg = encodeConfig(options);
  let out = encodeDocument(value, cfg.maxDepth, cfg.autoTabular);
  if (cfg.compress) {
    const alg = cfg.algorithm;
    const builtin = platform.compress[alg];
    // Fail fast, even for documents too small to compress, so a missing codec shows up in testing.
    if (!hasCodec(cfg.codecs, alg, 'compress') && builtin === undefined) {
      throw unavailable(alg, 'compression', webFormat(alg, 'CompressionStream') !== undefined);
    }
    if (out.length >= MIN_COMPRESSION_SIZE) {
      if (out.length > 0xffffffff) throw fail('size_limit', 'document too large to compress');
      const payload = callCodecSync(cfg.codecs, alg, 'compress', [out]) ?? builtin!(out);
      out = envelopeIfSmaller(out, payload, alg);
    }
  }
  if (cfg.hmacKey !== undefined) out = assembleSigned(platform.hmac(cfg.hmacKey, [SIGNED_HEADER, out]), out);
  return out;
}

export function decodeWith(data: BinaryInput, options: DecodeOptions | undefined, platform: Platform): unknown {
  const cfg = decodeConfig(options);
  let bytes = inputBytes(data);
  if (cfg.hmacKey !== undefined) {
    const env = signedEnvelope(bytes);
    const expected = platform.hmac(cfg.hmacKey, [env.header, env.payload]);
    if (!platform.equal(expected, env.mac)) throw fail('authentication_failed', 'HMAC verification failed');
    bytes = env.payload;
  } else {
    rejectUnexpectedSignature(bytes);
  }
  const env = compressionEnvelope(bytes, cfg);
  if (env !== null) {
    const { alg, payload, size } = env;
    let out = callCodecSync(cfg.codecs, alg, 'decompress', [payload, size]);
    if (out === undefined) {
      const builtin = platform.decompress[alg];
      if (builtin === undefined) throw unavailable(alg, 'decompression', mayDecompressAsync(alg));
      out = builtin(payload, size);
    }
    bytes = checkSize(out, size, alg);
  }
  return decodeDocument(bytes, cfg);
}

// --- asynchronous API -------------------------------------------------------------------------

export async function encodeAsyncWith(
  value: unknown,
  options: EncodeOptions | undefined,
  platform: Platform,
): Promise<Uint8Array<ArrayBuffer>> {
  const cfg = encodeConfig(options);
  let out = encodeDocument(value, cfg.maxDepth, cfg.autoTabular);
  if (cfg.compress) {
    const alg = cfg.algorithm;
    const builtin = platform.compress[alg];
    const format = webFormat(alg, 'CompressionStream');
    if (!hasCodec(cfg.codecs, alg, 'compress') && format === undefined && builtin === undefined) {
      throw unavailable(alg, 'compression', false);
    }
    if (out.length >= MIN_COMPRESSION_SIZE) {
      if (out.length > 0xffffffff) throw fail('size_limit', 'document too large to compress');
      let payload = await callCodecAsync(cfg.codecs, alg, 'compress', [out]);
      if (payload === undefined) payload = format !== undefined ? await webCompress(format, out) : builtin!(out);
      out = envelopeIfSmaller(out, payload, alg);
    }
  }
  if (cfg.hmacKey !== undefined) {
    const s = subtle();
    const mac = s !== undefined ? await webHmacSign(s, cfg.hmacKey, concat2(SIGNED_HEADER, out)) : platform.hmac(cfg.hmacKey, [SIGNED_HEADER, out]);
    out = assembleSigned(mac, out);
  }
  return out;
}

export async function decodeAsyncWith(
  data: BinaryInput,
  options: DecodeOptions | undefined,
  platform: Platform,
): Promise<unknown> {
  const cfg = decodeConfig(options);
  // A private copy: the caller may reuse its buffer while we wait.
  let bytes: Uint8Array = inputBytes(data).slice();
  if (cfg.hmacKey !== undefined) {
    const env = signedEnvelope(bytes);
    const s = subtle();
    const ok =
      s !== undefined
        ? await webHmacVerify(s, cfg.hmacKey, env.mac, concat2(env.header, env.payload))
        : platform.equal(platform.hmac(cfg.hmacKey, [env.header, env.payload]), env.mac);
    if (!ok) throw fail('authentication_failed', 'HMAC verification failed');
    bytes = env.payload;
  } else {
    rejectUnexpectedSignature(bytes);
  }
  const env = compressionEnvelope(bytes, cfg);
  if (env !== null) {
    const { alg, payload, size } = env;
    let out = await callCodecAsync(cfg.codecs, alg, 'decompress', [payload, size]);
    if (out === undefined) out = await decompressAsync(platform, alg, payload, size);
    bytes = checkSize(out, size, alg);
  }
  return decodeDocument(bytes, cfg);
}

/**
 * decodeAsync's decompressor. It reaches the same verdict as decode's: first the same
 * decompressor, in its non-blocking form where there is one (node:zlib), then the synchronous
 * one (the pure-JS inflate). A DecompressionStream is the last resort, only for a format that
 * the runtime has shown it handles strictly, and never for zstd.
 */
async function decompressAsync(platform: Platform, alg: CompressionAlgorithm, payload: Uint8Array, size: number): Promise<Uint8Array> {
  const nonBlocking = platform.decompressAsync?.[alg];
  if (nonBlocking !== undefined) return nonBlocking(payload, size);
  const builtin = platform.decompress[alg];
  if (builtin !== undefined) return builtin(payload, size);
  const format = await trustedDecompressionFormat(alg);
  if (format !== undefined) return webDecompress(alg, format, payload, size);
  if (mayDecompressAsync(alg)) {
    throw fail(
      'unsupported_compression',
      `${alg} decompression is not available in this environment: its DecompressionStream accepts bytes after the end of a stream; pass options.codecs.${alg}`,
    );
  }
  throw unavailable(alg, 'decompression', false);
}

