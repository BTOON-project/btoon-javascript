import { createHmac, timingSafeEqual } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { Platform } from './core.js';
import { fail } from './errors.js';
import { adler32 } from './inflate.js';
import type { CompressionAlgorithm } from './options.js';

type SyncFn = (data: Uint8Array, options?: Record<string, unknown>) => unknown;

function nodeFn(name: string): SyncFn | undefined {
  const f = (zlib as unknown as Record<string, unknown>)[name];
  return typeof f === 'function' ? (f as SyncFn) : undefined;
}

function plain(b: Uint8Array): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Wraps a node:zlib `*Sync` decompressor: output is capped at the declared size
 * (`maxOutputLength`), and input left over after the end of the stream is rejected.
 */
function decompressor(
  alg: CompressionAlgorithm,
  fn: SyncFn | undefined,
  extra?: (size: number) => Record<string, unknown>,
): ((data: Uint8Array, size: number) => Uint8Array) | undefined {
  if (fn === undefined) return undefined;
  return (data, size) => {
    let r: unknown;
    try {
      r = fn(data, { ...extra?.(size), info: true, maxOutputLength: Math.max(1, size) });
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw fail('invalid_envelope', `${alg} payload decompresses to more than the declared size`, e);
      }
      throw fail('invalid_envelope', `${alg} payload is corrupt: ${(e as Error).message}`, e);
    }
    let out: Uint8Array;
    let consumed: unknown;
    if (r instanceof Uint8Array) {
      out = r;
    } else {
      const info = r as { buffer: Uint8Array; engine?: { bytesWritten?: unknown } };
      out = info.buffer;
      consumed = info.engine?.bytesWritten;
    }
    if (typeof consumed === 'number') {
      if (consumed !== data.length) throw fail('invalid_envelope', `${alg} payload has trailing bytes`);
    } else if (alg === 'zlib') {
      // A runtime that doesn't report consumed input: the stream must end in its Adler-32.
      const n = data.length;
      const trailer = n >= 4 ? ((data[n - 4]! << 24) | (data[n - 3]! << 16) | (data[n - 2]! << 8) | data[n - 1]!) >>> 0 : -1;
      if (trailer !== adler32(out)) throw fail('invalid_envelope', 'zlib payload has trailing bytes');
    }
    return plain(out);
  };
}

function compressor(fn: SyncFn | undefined, options: Record<string, unknown>): ((data: Uint8Array) => Uint8Array) | undefined {
  if (fn === undefined) return undefined;
  return (data) => plain(fn(data, options) as Uint8Array);
}

const decompress: Partial<Record<CompressionAlgorithm, (data: Uint8Array, size: number) => Uint8Array>> = {};
const compress: Partial<Record<CompressionAlgorithm, (data: Uint8Array) => Uint8Array>> = {};

decompress.zlib = decompressor('zlib', nodeFn('inflateSync'));
compress.zlib = compressor(nodeFn('deflateSync'), { level: 6 });
const brotliQuality = (zlib.constants as Record<string, number> | undefined)?.BROTLI_PARAM_QUALITY;
if (brotliQuality !== undefined) {
  decompress.brotli = decompressor('brotli', nodeFn('brotliDecompressSync'));
  compress.brotli = compressor(nodeFn('brotliCompressSync'), { params: { [brotliQuality]: 6 } });
}
// node:zlib has Zstandard from Node.js 22.15 / 23.8. SPEC §6: bound the decoder's memory
// by rejecting frames whose window exceeds max(8 MiB, min(uncompressed_size, 128 MiB)).
const zstdWindowLogMax = (zlib.constants as Record<string, number> | undefined)?.ZSTD_d_windowLogMax;
decompress.zstd = decompressor('zstd', nodeFn('zstdDecompressSync'), (size) =>
  zstdWindowLogMax === undefined
    ? {}
    : { params: { [zstdWindowLogMax]: Math.ceil(Math.log2(Math.max(8 << 20, Math.min(size, 128 << 20)))) } },
);
compress.zstd = compressor(nodeFn('zstdCompressSync'), {});
for (const alg of Object.keys(decompress) as CompressionAlgorithm[]) {
  if (decompress[alg] === undefined) delete decompress[alg];
}
for (const alg of Object.keys(compress) as CompressionAlgorithm[]) {
  if (compress[alg] === undefined) delete compress[alg];
}

/** Node.js (and Bun): node:zlib for zlib, Brotli and Zstandard; node:crypto for HMAC. */
export const nodePlatform: Platform = {
  decompress,
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
