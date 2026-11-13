// decodeAsync reaches decode's verdict even where the runtime's DecompressionStream is lax
// (review 2026-11-13, X2). Node.js 18 to 23 ignore bytes after a zlib stream, Node.js 22 and
// 24 after a Brotli stream, and Bun bounds no Zstandard window; decodeAsync used to trust
// them. This process replaces DecompressionStream with one that does all three (node:test
// runs each file in its own process).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import zlib from 'node:zlib';

const lax = { deflate: zlib.inflateSync, brotli: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync };
const constructed = { deflate: 0, brotli: 0, zstd: 0 };

/** Decompresses everything it is given at once, ignoring anything after the stream. */
class LaxDecompressionStream {
  constructor(format) {
    const fn = lax[format];
    if (typeof fn !== 'function') throw new TypeError(`Unsupported compression format: '${format}'`);
    constructed[format]++;
    const chunks = [];
    const { readable, writable } = new TransformStream({
      transform(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      flush(controller) {
        controller.enqueue(new Uint8Array(fn(Buffer.concat(chunks))));
      },
    });
    this.readable = readable;
    this.writable = writable;
  }
}
globalThis.DecompressionStream = LaxDecompressionStream;

const { compressedCases, verdict } = await import('./helpers.mjs');
const require = createRequire(import.meta.url);
const builds = {
  'esm/node': await import('../dist/esm/node.js'),
  'esm/portable': await import('../dist/esm/index.js'),
  'cjs/node': require('../dist/cjs/node.js'),
  'cjs/portable': require('../dist/cjs/index.js'),
};

test('the lax stream really ignores trailing bytes', async () => {
  const z = zlib.deflateSync(Buffer.from('abc'));
  const s = new DecompressionStream('deflate');
  const w = s.writable.getWriter();
  w.write(Buffer.concat([z, Buffer.from([1, 2, 3])]));
  w.close();
  const out = [];
  for await (const chunk of s.readable) out.push(chunk);
  assert.equal(Buffer.concat(out).toString(), 'abc');
});

test('decodeAsync gives the same verdict as decode on every compressed payload', async () => {
  const doc = builds['esm/node'].encode({ msg: 'x'.repeat(300), n: [1, 2, 3] });
  for (const [name, lib] of Object.entries(builds)) {
    for (const [label, bytes] of compressedCases(doc)) {
      const sync = await verdict(() => lib.decode(bytes));
      const async = await verdict(() => lib.decodeAsync(bytes));
      assert.deepEqual(async, sync, `${name}, ${label}: decode ${JSON.stringify(sync)}, decodeAsync ${JSON.stringify(async)}`);
    }
  }
  // The lax stream was consulted (and failed the check), but never for zstd.
  assert.ok(constructed.brotli > 0);
  assert.equal(constructed.zstd, 0);
});
