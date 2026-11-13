// Where nothing else can decompress a payload, decodeAsync uses a DecompressionStream that
// has shown it rejects trailing bytes, but never for Zstandard, whose window it can't bound
// (SPEC §6). This process replaces DecompressionStream with a strict one that counts its uses
// (node:test runs each file in its own process).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

const strict = { deflate: zlib.inflateSync, brotli: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync };
const constructed = { deflate: 0, brotli: 0, zstd: 0 };

/** Decompresses everything it is given at once, and fails on anything after the stream. */
class StrictDecompressionStream {
  constructor(format) {
    const fn = strict[format];
    if (typeof fn !== 'function') throw new TypeError(`Unsupported compression format: '${format}'`);
    constructed[format]++;
    const chunks = [];
    const { readable, writable } = new TransformStream({
      transform(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      flush(controller) {
        const input = Buffer.concat(chunks);
        const r = fn(input, { info: true });
        if (r.engine.bytesWritten !== input.length) throw new TypeError('Junk found after end of compressed data.');
        controller.enqueue(new Uint8Array(r.buffer));
      },
    });
    this.readable = readable;
    this.writable = writable;
  }
}
globalThis.DecompressionStream = StrictDecompressionStream;

const { compressionEnvelope, verdict } = await import('./helpers.mjs');
const node = await import('../dist/esm/node.js');
const portable = await import('../dist/esm/index.js');

const value = { msg: 'y'.repeat(400) };
const doc = node.encode(value);

test('the portable build decodes Brotli through a strict DecompressionStream', async () => {
  const br = zlib.brotliCompressSync(doc);
  assert.deepEqual(await verdict(() => portable.decode(compressionEnvelope(3, br, doc.length))), { code: 'unsupported_compression' });
  assert.deepEqual(await portable.decodeAsync(compressionEnvelope(3, br, doc.length)), value);
  const withJunk = compressionEnvelope(3, Buffer.concat([br, Buffer.from([0])]), doc.length);
  assert.deepEqual(await verdict(() => portable.decodeAsync(withJunk)), { code: 'invalid_envelope' });
  const short = compressionEnvelope(3, br, doc.length + 1);
  assert.deepEqual(await verdict(() => portable.decodeAsync(short)), { code: 'invalid_envelope' });
  const used = constructed.brotli;
  assert.ok(used >= 3, `${used} Brotli streams`);
  // The Node build has node:zlib for Brotli, and doesn't need the stream.
  assert.deepEqual(await node.decodeAsync(compressionEnvelope(3, br, doc.length)), value);
  assert.equal(constructed.brotli, used);
});

test('zlib always uses the decoder that decode uses', async () => {
  const z = zlib.deflateSync(doc);
  for (const lib of [node, portable]) assert.deepEqual(await lib.decodeAsync(compressionEnvelope(0, z, doc.length)), value);
  assert.equal(constructed.deflate, 0);
});

test('zstd never goes through a DecompressionStream', { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
  const zs = compressionEnvelope(2, zlib.zstdCompressSync(doc), doc.length);
  assert.deepEqual(await verdict(() => portable.decodeAsync(zs)), { code: 'unsupported_compression' });
  assert.deepEqual(await node.decodeAsync(zs), value);
  assert.equal(constructed.zstd, 0);
});
