import type { Platform } from './core.js';
import { inflateZlib } from './inflate.js';
import { hmacSha256, timingSafeEqual } from './sha256.js';

/**
 * Environments without Node.js built-ins (browsers, Deno, workers): synchronous zlib
 * decompression and HMAC-SHA256 in pure JavaScript. Synchronous compression needs a
 * caller-supplied codec; encodeAsync uses CompressionStream instead.
 */
export const portablePlatform: Platform = {
  decompress: { zlib: inflateZlib },
  compress: {},
  hmac: hmacSha256,
  equal: timingSafeEqual,
};
