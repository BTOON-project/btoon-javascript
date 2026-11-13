// Asynchronous implementations on top of web platform APIs: Compression Streams and
// WebCrypto. Used by encodeAsync/decodeAsync wherever the runtime provides them.
import { BtoonError, fail } from './errors.js';
import type { CompressionAlgorithm } from './options.js';

const FORMATS: Partial<Record<CompressionAlgorithm, string>> = { zlib: 'deflate', brotli: 'brotli', zstd: 'zstd' };
// DecompressionStream has no way to bound a Zstandard window (SPEC §6), so it is never used
// for zstd.
const DECOMPRESSION_FORMATS: Partial<Record<CompressionAlgorithm, string>> = { zlib: 'deflate', brotli: 'brotli' };
const CHUNK = 64 * 1024;

type StreamCtor = new (format: string) => { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array> };

const supported = new Map<string, boolean>();

function streamCtor(kind: 'CompressionStream' | 'DecompressionStream'): StreamCtor | undefined {
  const ctor = (globalThis as Record<string, unknown>)[kind];
  return typeof ctor === 'function' ? (ctor as StreamCtor) : undefined;
}

/** The Compression Streams format name for `alg`, if this runtime supports it. */
export function webFormat(alg: CompressionAlgorithm, kind: 'CompressionStream' | 'DecompressionStream'): string | undefined {
  const format = FORMATS[alg];
  const Ctor = streamCtor(kind);
  if (format === undefined || Ctor === undefined) return undefined;
  const key = `${kind}:${format}`;
  let ok = supported.get(key);
  if (ok === undefined) {
    try {
      new Ctor(format);
      ok = true;
    } catch {
      ok = false;
    }
    supported.set(key, ok);
  }
  return ok ? format : undefined;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// Streams of the five bytes "BTOON" (zlib level 9, Brotli quality 11) for the trust probe.
const PROBE_TEXT = 'BTOON';
const PROBE_STREAMS: Record<string, string> = { deflate: '78da730af1f7f7030004780183', brotli: '0b028042544f4f4e03' };

const trust = new Map<string, Promise<boolean>>();

/**
 * Whether this runtime's DecompressionStream can be trusted with `format`: it must decode a
 * valid stream and reject one followed by a byte (in the same write or in the next), or by a
 * second stream. Node.js 18 to 23 (some later 22.x releases excepted) ignore bytes after a
 * zlib stream, and Node.js 22 and 24 after a Brotli stream, while SPEC §6 requires
 * `invalid_envelope`. Checked once per format.
 */
function trusted(format: string): Promise<boolean> {
  let p = trust.get(format);
  if (p === undefined) {
    p = probe(format);
    trust.set(format, p);
  }
  return p;
}

async function probe(format: string): Promise<boolean> {
  const hex = PROBE_STREAMS[format];
  if (hex === undefined) return false;
  const valid = fromHex(hex);
  const next = (extra: Uint8Array): Uint8Array => {
    const out = new Uint8Array(valid.length + extra.length);
    out.set(valid);
    out.set(extra, valid.length);
    return out;
  };
  try {
    const out = await decompressChunks(format, [valid], 64, format);
    if (String.fromCharCode(...out) !== PROBE_TEXT) return false;
  } catch {
    return false;
  }
  for (const chunks of [[next(Uint8Array.of(0))], [valid, Uint8Array.of(0)], [next(valid)]]) {
    try {
      await decompressChunks(format, chunks, 64, format);
      return false; // trailing bytes accepted
    } catch {
      // rejected, as it should be
    }
  }
  return true;
}

/**
 * The DecompressionStream format that decodeAsync may use for `alg` when no other
 * decompressor is available, or undefined: never for zstd, and only once the runtime has
 * shown that it rejects trailing bytes.
 */
export async function trustedDecompressionFormat(alg: CompressionAlgorithm): Promise<string | undefined> {
  const format = DECOMPRESSION_FORMATS[alg];
  if (format === undefined || webFormat(alg, 'DecompressionStream') === undefined) return undefined;
  return (await trusted(format)) ? format : undefined;
}

/** Whether decodeAsync might decompress `alg` with a DecompressionStream here (for error messages). */
export function mayDecompressAsync(alg: CompressionAlgorithm): boolean {
  return DECOMPRESSION_FORMATS[alg] !== undefined && webFormat(alg, 'DecompressionStream') !== undefined;
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, alg: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => undefined);
      throw fail('invalid_envelope', `${alg} payload decompresses to more than the declared size`);
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

/** Splits `data` into the chunks written to a stream. */
function chunked(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.subarray(i, Math.min(i + CHUNK, data.length)));
  return chunks;
}

/** Writes `chunks`, honouring backpressure, then closes the writer. */
async function pump(writer: WritableStreamDefaultWriter<Uint8Array>, chunks: readonly Uint8Array[]): Promise<void> {
  for (const chunk of chunks) {
    await writer.ready;
    await writer.write(chunk);
  }
  await writer.close();
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

export async function webCompress(format: string, data: Uint8Array): Promise<Uint8Array> {
  const stream = new (streamCtor('CompressionStream')!)(format);
  const writer = stream.writable.getWriter();
  const writing = pump(writer, chunked(data));
  writing.catch(() => undefined);
  const out = await readAll(stream.readable.getReader(), Infinity, format);
  await writing;
  return out;
}

/**
 * Runs `chunks` through a DecompressionStream. Output beyond `limit` bytes fails with
 * `invalid_envelope` ("<label> payload decompresses to more than the declared size").
 */
async function decompressChunks(format: string, chunks: readonly Uint8Array[], limit: number, label: string): Promise<Uint8Array> {
  const stream = new (streamCtor('DecompressionStream')!)(format);
  const writer = stream.writable.getWriter();
  const writing = pump(writer, chunks);
  writing.catch(() => undefined);
  try {
    const out = await readAll(stream.readable.getReader(), limit, label);
    await writing;
    return out;
  } catch (e) {
    writer.abort(e).catch(() => undefined);
    throw e;
  }
}

/**
 * Decompresses with a DecompressionStream, stopping as soon as the output exceeds `limit`
 * (the declared size). Only for a format that trustedDecompressionFormat() returned, which
 * rejects bytes after the end of the stream.
 */
export async function webDecompress(alg: CompressionAlgorithm, format: string, data: Uint8Array, limit: number): Promise<Uint8Array> {
  try {
    return await decompressChunks(format, chunked(data), limit, alg);
  } catch (e) {
    if (e instanceof BtoonError) throw e;
    throw fail('invalid_envelope', `${alg} payload is corrupt: ${messageOf(e)}`, e);
  }
}

type Subtle = {
  importKey(format: 'raw', key: Uint8Array, alg: { name: string; hash: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(alg: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(alg: string, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
};

/** WebCrypto's SubtleCrypto, if available (absent in Node 18 and on insecure origins). */
export function subtle(): Subtle | undefined {
  const c = (globalThis as { crypto?: { subtle?: Partial<Subtle> } }).crypto;
  const s = c?.subtle;
  return s && typeof s.importKey === 'function' && typeof s.sign === 'function' && typeof s.verify === 'function'
    ? (s as Subtle)
    : undefined;
}

async function importKey(s: Subtle, key: Uint8Array, usage: 'sign' | 'verify'): Promise<unknown> {
  try {
    return await s.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  } catch (e) {
    throw fail('invalid_argument', `cannot use hmacKey with WebCrypto: ${messageOf(e)}`, e);
  }
}

export async function webHmacSign(s: Subtle, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await importKey(s, key, 'sign');
  try {
    return new Uint8Array(await s.sign('HMAC', k, data));
  } catch (e) {
    throw fail('invalid_argument', `WebCrypto HMAC signing failed: ${messageOf(e)}`, e);
  }
}

/** Constant-time verification (crypto.subtle.verify compares internally). */
export async function webHmacVerify(s: Subtle, key: Uint8Array, mac: Uint8Array, data: Uint8Array): Promise<boolean> {
  const k = await importKey(s, key, 'verify');
  try {
    return await s.verify('HMAC', k, mac, data);
  } catch (e) {
    throw fail('authentication_failed', `WebCrypto HMAC verification failed: ${messageOf(e)}`, e);
  }
}
