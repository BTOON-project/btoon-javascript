// Conformance (SPEC §10, IMPLEMENTATION-GUIDE §1): every non-error vector decodes to its
// value, every canonical vector re-encodes byte-for-byte from its value and from what
// `timestamps: 'object'` decodes, every error vector is rejected with its code, and every
// encode_error vector's value is refused by the encoder with its code. Each vector's options
// apply. Runs against each build, synchronously and asynchronously.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { builds, fromTyped, hex, loadVectors, mismatch, reencodable, unhex, vectorOptions } from './helpers.mjs';

const doc = loadVectors();

test('vector file matches the implemented spec and defaults', () => {
  const lib = builds['esm/node'];
  assert.equal(doc.spec, lib.SPEC_VERSION);
  assert.deepEqual(doc.defaults, { max_depth: 128, max_decompressed_size: 64 * 1024 * 1024, max_values: 2 ** 20, strict: true });
  assert.ok(doc.vectors.length >= 311);
});

// Codecs backed by node:zlib, to run the optional-codec vectors through `options.codecs`
// on the portable build (which has no Brotli/Zstandard of its own).
const testCodecs = {
  brotli: { decompress: (d, n) => zlib.brotliDecompressSync(d, { maxOutputLength: Math.max(1, n) }) },
  ...(typeof zlib.zstdDecompressSync === 'function'
    ? { zstd: { decompress: (d, n) => zlib.zstdDecompressSync(d, { maxOutputLength: Math.max(1, n) }) } }
    : {}),
};

// SPEC §10: a canonical vector whose value the language can't represent distinctly MAY skip
// the re-encoding, but MUST still decode. In JavaScript that is only the float 0.0 (the
// integer 0 in JavaScript); dates and datetimes re-encode from BtoonDate and BtoonDateTime.
// See `reencodable` in helpers.mjs. The list is exact, so nothing else skips.
const NOT_REENCODABLE = ['float/0'];

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
    let refused = 0;
    for (const v of doc.vectors) {
      const { dec, enc } = vectorOptions(v);
      if (v.encode_error !== undefined) {
        // The value must be refused by the encoder (building it must succeed).
        const value = fromTyped(v.value, lib);
        try {
          const out = await encode(value, enc);
          failures.push(`${v.id}: expected encode error ${v.encode_error}, encoded ${hex(out)}`);
        } catch (e) {
          if (!(e instanceof lib.BtoonError)) failures.push(`${v.id}: encode threw a non-BtoonError: ${e}`);
          else if (e.code !== v.encode_error) failures.push(`${v.id}: expected encode error ${v.encode_error}, got ${e.code} (${e.message})`);
          else {
            passed++;
            refused++;
          }
        }
        continue;
      }
      const bytes = unhex(v.hex);
      if (codecs) dec.codecs = codecs;
      if (v.error !== undefined) {
        try {
          const got = await decode(bytes, dec);
          failures.push(`${v.id}: expected ${v.error}, decoded ${typeof got}`);
        } catch (e) {
          if (!(e instanceof lib.BtoonError)) failures.push(`${v.id}: threw a non-BtoonError: ${e}`);
          else if (v.requires && e.code === 'unsupported_compression' && e.code !== v.error) skipped.push(`${v.id} (requires ${v.requires})`);
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
        if (!reencodable(v.value)) {
          notReencoded.push(v.id);
        } else {
          const out = hex(await encode(fromTyped(v.value, lib), enc));
          if (out !== v.hex) {
            failures.push(`${v.id}: re-encoded as ${out}, expected ${v.hex}`);
            continue;
          }
          // What the lossless mode decodes writes the same bytes back (SPEC §10).
          const back = hex(await encode(await decode(bytes, { ...dec, timestamps: 'object' }), enc));
          if (back !== v.hex) {
            failures.push(`${v.id}: decoded with timestamps: 'object' and re-encoded as ${back}, expected ${v.hex}`);
            continue;
          }
          reencoded++;
        }
      }
      passed++;
    }
    const line =
      `${label}: ${passed}/${doc.vectors.length} passed, ${reencoded} canonical re-encodings byte-exact, ` +
      `${refused} encode errors, skipped: [${skipped.join(', ')}], not re-encodable in JS: [${notReencoded.join(', ')}]`;
    // Every date and datetime vector is among the re-encoded ones (SPEC §10).
    const typedIds = doc.vectors.filter((x) => x.canonical && /"date(time)?"/.test(JSON.stringify(x.value))).map((x) => x.id);
    summary.push(line);
    t.diagnostic(line);
    assert.deepEqual(failures, []);
    // Only codecs that are genuinely missing may be skipped. Nothing here decodes LZ4, so every
    // vector that needs it is skipped, the lz4-block/* end-of-block cases among them.
    for (const s of skipped) assert.match(s, /requires (lz4|zstd|brotli|snappy)/);
    const lz4 = doc.vectors.filter((x) => x.requires === 'lz4').map((x) => `${x.id} (requires lz4)`);
    assert.ok(lz4.filter((x) => x.startsWith('lz4-block/')).length >= 8);
    for (const id of lz4) assert.ok(skipped.includes(id), id);
    assert.deepEqual(notReencoded, NOT_REENCODABLE);
    for (const id of ['date/max', 'date/min', 'datetime/max', 'datetime/min', 'tabular/date-and-datetime-columns']) assert.ok(typedIds.includes(id), id);
    assert.ok(typedIds.every((id) => !notReencoded.includes(id)));
    assert.equal(refused, doc.vectors.filter((v) => v.encode_error !== undefined).length);
  });
}
