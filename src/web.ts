// Asynchronous implementations on top of web platform APIs: Compression Streams and
// WebCrypto. Used by encodeAsync/decodeAsync wherever the runtime provides them.
import { BtoonError, fail } from './errors.js';
import { adler32 } from './inflate.js';
import type { CompressionAlgorithm } from './options.js';

const FORMATS: Partial<Record<CompressionAlgorithm, string>> = { zlib: 'deflate', brotli: 'brotli', zstd: 'zstd' };
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

/** Feeds `data` in chunks, honouring backpressure, then closes the writer. */
async function pump(writer: WritableStreamDefaultWriter<Uint8Array>, data: Uint8Array): Promise<void> {
  for (let i = 0; i < data.length; i += CHUNK) {
    await writer.ready;
    await writer.write(data.subarray(i, Math.min(i + CHUNK, data.length)));
  }
  await writer.close();
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

export async function webCompress(format: string, data: Uint8Array): Promise<Uint8Array> {
  const stream = new (streamCtor('CompressionStream')!)(format);
  const writer = stream.writable.getWriter();
  const writing = pump(writer, data);
  writing.catch(() => undefined);
  const out = await readAll(stream.readable.getReader(), Infinity, format);
  await writing;
  return out;
}

/**
 * Decompresses with a DecompressionStream, stopping as soon as the output exceeds
 * `limit` (the declared size). For zlib it also checks that the payload ends with the
 * Adler-32 of the output: older runtimes silently ignore bytes after the end of the
 * stream, which a strict decoder must reject.
 */
export async function webDecompress(alg: CompressionAlgorithm, format: string, data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new (streamCtor('DecompressionStream')!)(format);
  const writer = stream.writable.getWriter();
  const writing = pump(writer, data);
  writing.catch(() => undefined);
  let out: Uint8Array;
  try {
    out = await readAll(stream.readable.getReader(), limit, alg);
    await writing;
  } catch (e) {
    writer.abort(e).catch(() => undefined);
    if (e instanceof BtoonError) throw e;
    throw fail('invalid_envelope', `${alg} payload is corrupt: ${messageOf(e)}`, e);
  }
  if (alg === 'zlib') {
    const n = data.length;
    const trailer = n >= 4 ? ((data[n - 4]! << 24) | (data[n - 3]! << 16) | (data[n - 2]! << 8) | data[n - 1]!) >>> 0 : -1;
    if (trailer !== adler32(out)) throw fail('invalid_envelope', 'zlib payload has trailing bytes');
  }
  return out;
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
