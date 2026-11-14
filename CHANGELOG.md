# Changelog

## 0.3.0 (2026-11-14): BTOON spec 0.3

Implements [spec 0.3](https://github.com/BTOON-project/btoon-core/blob/main/docs/SPEC.md).
The wire format is unchanged. `SPEC_VERSION` is now `'0.3'`, and every
BTOON type round-trips: @btoon/js can now write dates and datetimes. This release also fixes
the remaining @btoon/js findings of the 2026-11-13 review, and its behavior matches the
native `btoon` package 0.3.0 exactly. Behavior changes are marked.

- **New: `BtoonDate` and `BtoonDateTime`**, typed values for the date (-2) and datetime (-3)
  extensions. Both subclass `Timestamp` and hold the exact value on the wire,
  `epochMilliseconds` or `epochNanoseconds`, a `bigint` in the int64 range; the inherited
  `seconds` and `nanoseconds` describe the same instant, floored, and `offsetMinutes` is
  `undefined`. The constructors take a `bigint` or a safe-integer `number`. `fromDate(date)`,
  `fromTimestamp(ts)` and the inherited `toDate()` convert: a date floors to the
  millisecond, and a `Timestamp` with a UTC offset or out of range is `invalid_argument`.
  `encode` writes them as `fixext 8` with a big-endian `i64`, table cells included. A `Date`
  still encodes as a timestamp (-1). A raw `Ext(-2)` or `Ext(-3)` is still refused, now
  with a message that names these types.
- **Behavior change:** with `timestamps: 'object'`, a date decodes to a `BtoonDate` and a
  datetime to a `BtoonDateTime`, not a plain `Timestamp`, so a decoded document encodes
  back to the same bytes. Code that checks `instanceof Timestamp` or reads
  `seconds`/`nanoseconds` keeps working. With the default `'date'`, a date outside the
  range of `Date` decodes to a `BtoonDate` instead of a `Timestamp`. Everything else still
  decodes to a `Date`.
- **Fixed:** input in a `SharedArrayBuffer` failed to decode in browsers, as `invalid_utf8`
  (or `size_limit` with `strict: false`): their `TextDecoder` refuses views of shared
  memory. `decode` now copies shared input once before reading it, as it already did with
  `hmacKey`.
- **Fixed:** a plain object (an object literal or `Object.create(null)`) with its own
  `toJSON()` threw `invalid_argument` ("cannot encode a function"), where `JSON.stringify`
  and the native package call it. **Behavior change:** it now encodes as what its `toJSON()`
  returns, called once, as rows and cells of tables too. An inherited `toJSON`, such as a
  polluted `Object.prototype.toJSON`, is still ignored for plain objects.
- **Fixed:** `instanceof Timestamp`, `Ext` and `BtoonError` were false for values from the
  other build (CommonJS or ESM) or another copy of the package, though the encoder accepted
  them. `instanceof` now checks their brands (`Symbol.hasInstance`), and so do `BtoonDate`
  and `BtoonDateTime`. `BtoonError` has a brand now too. Subclasses you write keep the
  ordinary `instanceof`.
- **Fixed:** a getter that changed the rows of a table while it was written (emptying the
  array, or replacing or removing a row) made `encode` throw a raw `TypeError`. The table is
  now written from the rows as they were when it was planned; each cell is still read as it
  is written.
- **Changed:** `new Timestamp(seconds)` defaults `nanoseconds` to 0, as the native package
  does. It was required.
- **Behavior change:** `bigint: 'always'` depends on the value only. Every integer outside
  [-2^31, 2^32-1] decodes to a `bigint`, which is what a canonical encoder writes with a
  64-bit marker or as a bigint extension. It used to depend on the encoding: a non-canonical
  `cf 0000000000000005`, or a bigint extension holding 5, gave `5n` while `05` gave `5`,
  although SPEC §7 asks for the same value whatever the encoding. Canonical input decodes as
  before. The native `btoon` package 0.3.0 follows the same rule, which is a behavior change
  there: it gave a `bigint` for every integer, so `decode(encode(5), { bigint: 'always' })` is
  now `5`, not `5n`.
- **New:** a Proxy of a `Map`, such as Vue's and MobX's reactive Maps, encodes like its
  target, read through the proxy's own `keys()` and `get()`. It threw a `TypeError` before,
  as a bare Proxy of a Map still does. One whose `keys()` repeats a key throws
  `invalid_argument`. Maps themselves, subclasses included, are still read with the
  intrinsic `Map` methods, so an overridden iterator can't repeat a key.
- **Fixed:** a Proxy of an array whose `length` isn't an integer in [0, 2^32-1] wrote a
  malformed array. It now throws `invalid_argument`.
- `Timestamp.fromDate(invalidDate)` says "cannot convert an invalid Date" (the code is still
  `invalid_argument`).
- **Docs:** the README covers the typed date values, `instanceof` across copies, shared
  memory, `bigint: 'always'`, and what a custom `decompress` must reject (bytes after the
  stream, and LZ4 blocks that break the end-of-block conditions, SPEC §6).
- **Tests:** the conformance harness runs the 311 spec 0.3 vectors. It re-encodes the date
  and datetime vectors from `BtoonDate` and `BtoonDateTime`, and checks that every canonical
  vector decoded with `timestamps: 'object'` encodes back to its bytes. Only `float/0` still
  skips its re-encoding. The `lz4-block/*` vectors are skipped, as @btoon/js has no LZ4 of
  its own. New regression tests cover each fix above, shared input runs against a
  `TextDecoder` that refuses shared views as browsers' does, and `test/parity-cases.cjs`
  holds API cases that the native package runs too, with the same expected results.

## 0.2.0 (2026-11-14): BTOON spec 0.2

Implements [spec 0.2](https://github.com/BTOON-project/btoon-core/blob/main/docs/SPEC.md)
(decisions D23–D26). The wire format is unchanged, and every valid 0.1 document that fits
the new limits decodes to the same value. `SPEC_VERSION` is now `'0.2'`. Behavior changes:

- **New decode option `maxValues`** (default 1,048,576 = 2^20): a document may decode to at
  most that many values, or `decode` throws `size_limit`. A value counts once, when it
  starts and before anything inside it: the top-level value, array elements, map values
  (not keys), and extension values of every type. A tabular array counts once, then its
  rows all together once its header is checked, then each cell. Values inside a
  compression envelope count. Documents with more values, such as a table of 150,000 rows
  of 6 columns, now need a larger `maxValues`. With the defaults, the costliest hostile
  input found (a 64 KB envelope of empty float vectors) peaks at about 0.6 GB. Errors are still reported front to back: the
  value that crosses the limit fails with `size_limit` before its marker is examined.
- **Tabular column names are bounded:** a table whose rows × UTF-8 bytes of its column names
  exceeds `maxDecompressedSize` throws `size_limit`, in bare documents too. With the
  default, that is 64 MiB of names copied into the rows.
- **`maxDecompressedSize` defaults to 64 MiB** (67,108,864 bytes), down from 256 MiB. Larger
  envelopes need the option.
- **`maxDepth` above 1000 throws `invalid_argument`**, in `encode` and `decode` and their
  async forms. Any non-negative safe integer was accepted before.
- **Non-strict mode validates map keys and column names.** Invalid UTF-8 in either throws
  `invalid_utf8` with `strict: false` too. Before, it was replaced with U+FFFD, which could
  merge two distinct keys and silently drop a value, and made distinct column names fail as
  duplicates (`invalid_tabular`). String values are still replaced in non-strict mode.
- **Column names are checked front to back**: each name first for UTF-8, then against the
  earlier names. Before, all names were checked for UTF-8 first, so a table with a
  duplicate name followed by an invalid one failed with `invalid_utf8`; now it fails with
  `invalid_tabular`, as in the other implementations.
- **`Ext` with an id BTOON defines is refused**: `encode` throws `invalid_argument` for ids
  -1…-6 and -10, even with a valid payload (SPEC §5.7). Before, the payload was validated
  and written verbatim, which could produce non-canonical output (`Ext(-4, 05)` wrote
  `d4fc05`). This was also the documented way to write `date` (-2) and `datetime` (-3)
  values, which @btoon/js now can't write: `Date` and `Timestamp` encode as timestamps. The
  `Ext` constructor still accepts these ids. Ids reserved for future versions (-7…-9,
  -11…-128) are written as given, as before.
- **zlib streams with a preset dictionary (FDICT) are refused** with `invalid_envelope`
  before any decompressor runs, including a caller's `codecs.zlib`. The built-in
  decompressors already rejected them.
- `hmacKey: null` still throws `invalid_argument` (only an absent `hmacKey` means "no
  key"), now with a message that says so, as does an empty key.
- An `Ext` whose `data` was later replaced by something other than a `Uint8Array` now
  throws `invalid_argument` instead of writing a corrupt document.
- A call that runs out of JavaScript stack (because it started with little stack left)
  reports `max_depth` on Node.js 24 and 26 too. There, it leaked a `SyntaxError` from
  compiling a regular expression with no stack left.
- The nested-table documents from 0.1.2's denial-of-service fix now fail sooner, with
  `size_limit`, because their rows count at each header.

The test suite runs the 298 spec 0.2 vectors with each vector's options, the
`encode_error` vectors, and float vectors compared bit for bit.

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
