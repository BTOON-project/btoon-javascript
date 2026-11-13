import { createHmac, timingSafeEqual } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { Platform } from './core.js';
import { fail } from './errors.js';
import { inflateZlib } from './inflate.js';
import type { CompressionAlgorithm } from './options.js';

type SyncFn = (data: Uint8Array, options?: Record<string, unknown>) => unknown;
type AsyncFn = (data: Uint8Array, options: Record<string, unknown>, callback: (error: Error | null, result: unknown) => void) => void;
type Decompress = (data: Uint8Array, size: number) => Uint8Array;
type DecompressAsync = (data: Uint8Array, size: number) => Promise<Uint8Array>;
type Extra = (size: number) => Record<string, unknown>;

function nodeFn<T>(name: string): T | undefined {
  const f = (zlib as unknown as Record<string, unknown>)[name];
  return typeof f === 'function' ? (f as T) : undefined;
}

function plain(b: Uint8Array): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** node:zlib options: output capped at the declared size, and `info` to learn how much input was consumed. */
function options(size: number, extra: Extra | undefined): Record<string, unknown> {
  return { ...extra?.(size), info: true, maxOutputLength: Math.max(1, size) };
}

function failure(alg: CompressionAlgorithm, e: unknown): Error {
  if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
    return fail('invalid_envelope', `${alg} payload decompresses to more than the declared size`, e);
  }
  return fail('invalid_envelope', `${alg} payload is corrupt: ${(e as Error).message}`, e);
}

/** The output of a node:zlib decompressor, once it is clear that the stream used the whole payload. */
function output(alg: CompressionAlgorithm, data: Uint8Array, size: number, r: unknown): Uint8Array {
  let out: Uint8Array;
  let consumed: unknown;
  if (r instanceof Uint8Array) {
    out = r;
  } else {
    const info = r as { buffer: Uint8Array; engine?: { bytesWritten?: unknown } };
    out = info.buffer;
    consumed = info.engine?.bytesWritten;
  }
  if (typeof consumed !== 'number') {
    // A runtime that doesn't report the input it consumed can't show that no bytes follow the
    // stream (SPEC §6). zlib has an exact pure-JS decoder; the other algorithms don't.
    if (alg === 'zlib') return inflateZlib(data, size);
    throw fail('unsupported_compression', `${alg} decompression in this runtime cannot detect trailing bytes; pass options.codecs.${alg}`);
  }
  if (consumed !== data.length) throw fail('invalid_envelope', `${alg} payload has trailing bytes`);
  return plain(out);
}

/** Wraps a node:zlib `*Sync` decompressor, for decode. */
function decompressor(alg: CompressionAlgorithm, fn: SyncFn | undefined, extra?: Extra): Decompress | undefined {
  if (fn === undefined) return undefined;
  return (data, size) => {
    let r: unknown;
    try {
      r = fn(data, options(size, extra));
    } catch (e) {
      throw failure(alg, e);
    }
    return output(alg, data, size, r);
  };
}

/**
 * Wraps the callback form of the same node:zlib decompressor, for decodeAsync: it runs on the
 * thread pool, with the same limits and checks, so both give the same verdict.
 */
function asyncDecompressor(alg: CompressionAlgorithm, fn: AsyncFn | undefined, extra?: Extra): DecompressAsync | undefined {
  if (fn === undefined) return undefined;
  return (data, size) =>
    new Promise<Uint8Array>((resolve, reject) => {
      fn(data, options(size, extra), (e, r) => {
        if (e) {
          reject(failure(alg, e));
          return;
        }
        try {
          resolve(output(alg, data, size, r));
        } catch (err) {
          reject(err);
        }
      });
    });
}

function compressor(fn: SyncFn | undefined, opts: Record<string, unknown>): ((data: Uint8Array) => Uint8Array) | undefined {
  if (fn === undefined) return undefined;
  return (data) => plain(fn(data, opts) as Uint8Array);
}

const decompress: Partial<Record<CompressionAlgorithm, Decompress>> = {};
const decompressAsync: Partial<Record<CompressionAlgorithm, DecompressAsync>> = {};
const compress: Partial<Record<CompressionAlgorithm, (data: Uint8Array) => Uint8Array>> = {};

decompress.zlib = decompressor('zlib', nodeFn('inflateSync'));
decompressAsync.zlib = asyncDecompressor('zlib', nodeFn('inflate'));
compress.zlib = compressor(nodeFn('deflateSync'), { level: 6 });
const brotliQuality = (zlib.constants as Record<string, number> | undefined)?.BROTLI_PARAM_QUALITY;
if (brotliQuality !== undefined) {
  decompress.brotli = decompressor('brotli', nodeFn('brotliDecompressSync'));
  decompressAsync.brotli = asyncDecompressor('brotli', nodeFn('brotliDecompress'));
  compress.brotli = compressor(nodeFn('brotliCompressSync'), { params: { [brotliQuality]: 6 } });
}
// node:zlib has Zstandard from Node.js 22.15 / 23.8. SPEC §6: bound the decoder's memory by
// rejecting frames whose window exceeds max(8 MiB, min(uncompressed_size, 128 MiB)). Without
// the windowLogMax parameter there is no bound, so zstd decompression is not offered at all.
const zstdWindowLogMax = (zlib.constants as Record<string, number> | undefined)?.ZSTD_d_windowLogMax;
if (zstdWindowLogMax !== undefined) {
  const zstdWindow: Extra = (size) => ({
    params: { [zstdWindowLogMax]: Math.ceil(Math.log2(Math.max(8 << 20, Math.min(size, 128 << 20)))) },
  });
  decompress.zstd = decompressor('zstd', nodeFn('zstdDecompressSync'), zstdWindow);
  decompressAsync.zstd = asyncDecompressor('zstd', nodeFn('zstdDecompress'), zstdWindow);
}
compress.zstd = compressor(nodeFn('zstdCompressSync'), {});
for (const table of [decompress, decompressAsync, compress] as Partial<Record<CompressionAlgorithm, unknown>>[]) {
  for (const alg of Object.keys(table) as CompressionAlgorithm[]) {
    if (table[alg] === undefined) delete table[alg];
  }
}

/** Node.js (and Bun): node:zlib for zlib, Brotli and Zstandard; node:crypto for HMAC. */
export const nodePlatform: Platform = {
  decompress,
  decompressAsync,
  compress,
  hmac(key, parts) {
    const h = createHmac('sha256', key);
    for (const p of parts) h.update(p);
    return plain(h.digest());
  },
  equal(a, b) {
    return a.length === b.length && timingSafeEqual(a, b);
  },
};
