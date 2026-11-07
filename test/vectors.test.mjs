// Conformance (SPEC §10, IMPLEMENTATION-GUIDE §1): every non-error vector decodes to its
// value, every canonical vector re-encodes byte-for-byte, every error vector is rejected
// with its code. Runs against each build, synchronously and asynchronously.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { builds, fromTyped, hex, jsRepresentable, loadVectors, mismatch, unhex, vectorOptions } from './helpers.mjs';

const doc = loadVectors();

test('vector file matches the implemented spec and defaults', () => {
  const lib = builds['esm/node'];
  assert.equal(doc.spec, lib.SPEC_VERSION);
  assert.deepEqual(doc.defaults, { max_depth: 128, max_decompressed_size: 268435456, strict: true });
  assert.ok(doc.vectors.length >= 200);
});

// Codecs backed by node:zlib, to run the optional-codec vectors through `options.codecs`
// on the portable build (which has no Brotli/Zstandard of its own).
const testCodecs = {
  brotli: { decompress: (d, n) => zlib.brotliDecompressSync(d, { maxOutputLength: Math.max(1, n) }) },
  ...(typeof zlib.zstdDecompressSync === 'function'
    ? { zstd: { decompress: (d, n) => zlib.zstdDecompressSync(d, { maxOutputLength: Math.max(1, n) }) } }
    : {}),
};

const modes = [];
for (const [name, lib] of Object.entries(builds)) {
  for (const sync of [true, false]) modes.push({ name, lib, sync, codecs: undefined });
}
modes.push({ name: 'esm/portable+codecs', lib: builds['esm/portable'], sync: true, codecs: testCodecs });
modes.push({ name: 'esm/portable+codecs', lib: builds['esm/portable'], sync: false, codecs: testCodecs });

export const summary = [];

for (const { name, lib, sync, codecs } of modes) {
  const label = `${name} ${sync ? 'sync' : 'async'}`;
  test(`conformance vectors: ${label}`, async (t) => {
    const decode = sync ? (b, o) => lib.decode(b, o) : (b, o) => lib.decodeAsync(b, o);
    const encode = sync ? (v, o) => lib.encode(v, o) : (v, o) => lib.encodeAsync(v, o);
    const failures = [];
    const skipped = [];
    const notReencoded = [];
    let passed = 0;
    let reencoded = 0;
    for (const v of doc.vectors) {
      const bytes = unhex(v.hex);
      const { dec, enc } = vectorOptions(v);
      if (codecs) dec.codecs = codecs;
      if (v.error !== undefined) {
        try {
          const got = await decode(bytes, dec);
          failures.push(`${v.id}: expected ${v.error}, decoded ${typeof got}`);
        } catch (e) {
          if (!(e instanceof lib.BtoonError)) failures.push(`${v.id}: threw a non-BtoonError: ${e}`);
          else if (e.code !== v.error) failures.push(`${v.id}: expected ${v.error}, got ${e.code} (${e.message})`);
          else passed++;
        }
        continue;
      }
      let ok = true;
      for (const extra of [{ timestamps: 'object' }, {}, { bigint: 'always' }]) {
        let got;
        try {
          got = await decode(bytes, { ...dec, ...extra });
        } catch (e) {
          if (v.requires && e instanceof lib.BtoonError && e.code === 'unsupported_compression') {
            skipped.push(`${v.id} (requires ${v.requires})`);
          } else {
            failures.push(`${v.id}: decode failed: ${e?.code ?? ''} ${e?.message ?? e}`);
          }
          ok = false;
          break;
        }
        const m = mismatch(got, v.value, lib, extra);
        if (m) {
          failures.push(`${v.id} ${JSON.stringify(extra)}: ${m}`);
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (v.canonical) {
        if (!jsRepresentable(v.value)) {
          notReencoded.push(v.id);
        } else {
          const out = hex(await encode(fromTyped(v.value, lib), enc));
          if (out !== v.hex) {
            failures.push(`${v.id}: re-encoded as ${out}, expected ${v.hex}`);
            continue;
          }
          reencoded++;
        }
      }
      passed++;
    }
    const line =
      `${label}: ${passed}/${doc.vectors.length} passed, ${reencoded} canonical re-encodings byte-exact, ` +
      `skipped: [${skipped.join(', ')}], not re-encodable in JS: [${notReencoded.join(', ')}]`;
    summary.push(line);
    t.diagnostic(line);
    assert.deepEqual(failures, []);
    // Only codecs that are genuinely missing may be skipped.
    for (const s of skipped) assert.match(s, /requires (lz4|zstd|brotli|snappy)/);
    assert.deepEqual(notReencoded, ['float/0'], 'only 0.0 is indistinguishable from the integer 0 in JS');
  });
}
