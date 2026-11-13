# Changelog

## 0.1.2 (2026-11-13)

- **Fixed (security):** `decodeAsync` accepted compressed payloads that `decode` rejects,
  because it trusted the runtime's `DecompressionStream`:
  - bytes after a zlib stream on Node.js 18 to 23 (some later 22.x releases excepted), when
    they ended in a copy of the stream's Adler-32;
  - bytes after a Brotli stream on Node.js 22 and 24;
  - Zstandard frames whose window exceeds the SPEC §6 bound, on Bun.

  `decodeAsync` now uses the decompressors `decode` uses: `node:zlib` (its asynchronous
  functions, on the thread pool) in the Node.js entry, and the pure-JS inflate for zlib in
  the portable entry. A `DecompressionStream` is only a last resort for Brotli in the
  portable entry, once the runtime has shown that it rejects bytes after the end of a
  stream, and is never used for Zstandard. The Adler-32 heuristic is gone.
- **Fixed (denial of service):** nested containers no longer allocate for the element counts
  their headers announce. Each level was checked against the same remaining bytes, so 1 MiB
  documents of 64 nested tabulars or 127 nested array32 headers (1.6 KB and 1.3 KB as zlib
  envelopes) took 4.2 GB and 1 GB, or ended the process with a fatal "JavaScript heap out
  of memory". Arrays now allocate at most 1,024 slots up front (the open ones of a document
  at most 65,536 together) and grow as elements arrive, and each tabular row is created
  once its first cell is decoded. The same documents now fail with their error code in
  milliseconds, using about 30 MB for the arrays (mostly the innermost array's million
  elements) and nothing measurable for the tabulars.
- **Changed:**
  - In the portable entry, `decodeAsync` no longer decompresses Zstandard (it did on Bun)
    and decompresses Brotli only where the runtime's `DecompressionStream` rejects trailing
    bytes (not on Node.js 22 and 24, for example). Elsewhere it fails with
    `unsupported_compression`, as `decode` does; pass `options.codecs` to decode them.
  - In the Node.js entry, `decodeAsync` decompresses with `node:zlib` instead of
    `DecompressionStream`, and Zstandard is decompressed only where `node:zlib` can bound
    the window (`ZSTD_d_windowLogMax`; Node.js 22.15+ and Bun have it).

## 0.1.1 (2026-11-07)

- First release published from CI, with npm provenance. No code changes.

## 0.1.0 (2026-11-07)

First release: a pure TypeScript implementation of BTOON spec 0.1.
