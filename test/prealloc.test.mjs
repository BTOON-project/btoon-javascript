// Nested containers must not allocate for the element counts they announce (review
// 2026-11-13, X1). Each level was checked against the same remaining bytes, so a 1 MiB
// document of 64 nested tabulars built 4 GB of empty rows and ended in a fatal, uncatchable
// "JavaScript heap out of memory". These documents are decoded in a worker whose heap is
// capped at 64 MB: a regression shows up as ERR_WORKER_OUT_OF_MEMORY instead of the error
// code the document deserves. Since spec 0.2 the default maxValues stops the nested tables
// early (their rows count at each header), so they are also decoded with maxValues lifted,
// which leaves only the pre-allocation bound in the way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { builds } from './helpers.mjs';

const ENTRIES = { node: new URL('../dist/esm/node.js', import.meta.url).href, portable: new URL('../dist/esm/index.js', import.meta.url).href };
const PAYLOAD = 256 * 1024;

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** `levels` array32 headers, each announcing every byte after it, then PAYLOAD nils. */
function nestedArrays(levels) {
  const doc = new Uint8Array(levels * 5 + PAYLOAD).fill(0xc0);
  for (let i = 0; i < levels; i++) doc.set([0xdd, ...be32(doc.length - i * 5 - 5)], i * 5);
  return doc;
}

/** A tabular with one column "a" holding just `cell`, announcing `rows` rows. */
function tabular(cell, rows) {
  const head = [...be32(1), ...be32(1), ...be32(rows), ...be32(1), 0x61, 9, ...be32(cell.length)];
  const out = new Uint8Array(6 + head.length + cell.length);
  out.set([0xc9, ...be32(head.length + cell.length), 0xf6]);
  out.set(head, 6);
  out.set(cell, 6 + head.length);
  return out;
}

/**
 * 64 nested tabulars: the innermost one is valid; every other level announces as many rows
 * as its payload could hold, but its column holds only the next level.
 */
function nestedTabulars(innermost) {
  let doc = innermost;
  for (let i = 1; i < 64; i++) doc = tabular(doc, doc.length + 4);
  return doc;
}

function decodeInWorker(entry, doc, options) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.entry).then((lib) => {
      try {
        lib.decode(workerData.doc, workerData.options);
        parentPort.postMessage('ok');
      } catch (e) {
        parentPort.postMessage(e.code ?? String(e));
      }
    });`;
  return new Promise((resolve) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { entry, doc, options },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    worker.once('message', resolve);
    worker.once('error', (e) => resolve(e.code ?? String(e)));
  });
}

// [name, document, verdict with the default options, verdict with maxValues lifted]
const cases = [
  ['127 nested array32 headers', nestedArrays(127), 'truncated', 'truncated'],
  ['64 nested tabulars around a binary', nestedTabulars(tabular(Uint8Array.from([0xc6, ...be32(PAYLOAD), ...new Uint8Array(PAYLOAD)]), 1)), 'size_limit', 'invalid_tabular'],
  ['64 nested tabulars around nil rows', nestedTabulars(tabular(new Uint8Array(PAYLOAD / 4).fill(0xc0), PAYLOAD / 4)), 'size_limit', 'invalid_tabular'],
];

for (const [name, doc, byDefault, lifted] of cases) {
  test(`${name}: decoded within a 64 MB heap`, async () => {
    for (const [build, entry] of Object.entries(ENTRIES)) {
      const what = `${build} build, ${doc.length}-byte input`;
      assert.equal(await decodeInWorker(entry, doc, {}), byDefault, `${what}, default options`);
      assert.equal(await decodeInWorker(entry, doc, { maxValues: 2 ** 40 }), lifted, `${what}, maxValues 2^40`);
    }
  });
}

test('containers beyond the reservation, and nesting beyond the budget, decode the same', () => {
  for (const lib of [builds['esm/node'], builds['esm/portable'], builds['cjs/portable']]) {
    for (const n of [1023, 1024, 1025, 5000, 70000]) {
      const arr = Array.from({ length: n }, (_, i) => i);
      assert.deepEqual(lib.decode(lib.encode(arr)), arr);
      const rows = Array.from({ length: n }, (_, i) => ({ id: i, name: `u${i}` }));
      const packed = lib.encode(rows);
      assert.equal(packed[{ 0xc7: 2, 0xc8: 3, 0xc9: 5 }[packed[0]]], 0xf6, 'tabular');
      assert.deepEqual(lib.decode(packed), rows);
    }
    // 100 levels of 1100 elements: the document's reservation budget runs out at level 64.
    let deep = 'leaf';
    for (let i = 0; i < 100; i++) deep = [deep, ...Array.from({ length: 1099 }, (_, j) => j)];
    assert.deepEqual(lib.decode(lib.encode(deep)), deep);
  }
});
