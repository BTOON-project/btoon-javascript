# @btoon/js

BTOON ("Binary TOON") for JavaScript and TypeScript. BTOON is
[MessagePack](https://github.com/msgpack/msgpack/blob/master/spec.md) with a canonical
encoding, a columnar ("tabular") encoding for arrays of uniform objects, a few extension
types (timestamp, date, datetime, bigint, float32/float64 vectors), an optional
compression envelope and an optional HMAC-signed envelope.

- **Pure TypeScript, zero runtime dependencies.** Runs in browsers, Node.js ≥ 18, Deno,
  Bun and edge runtimes (Cloudflare Workers, Vercel Edge). ESM and CommonJS builds with
  type definitions.
- **Conforming.** Implements [BTOON spec 0.1](https://github.com/BTOON-project/btoon-core/blob/main/docs/SPEC.md)
  and passes all 260 conformance vectors of btoon-core (see [Conformance](#conformance)).
- **Canonical.** The same value encodes to the same bytes as in every other conforming
  implementation (C++, Python, Go, PHP), so encodings can be hashed, cached and signed.
- **Hardened decoder.** Bounds-checked reads, a nesting limit, no allocation larger than
  the input justifies, strict UTF-8, duplicate-key rejection, capped decompression, and
  signatures verified before anything is parsed.

Implements spec 0.1. In Node.js it is also the fastest BTOON package: on
10,000 records it encodes in 1.1 ms and decodes in 1.6 ms, against 7.8 ms and 7.1 ms for
the native [`btoon`](https://github.com/BTOON-project/btoon-nodejs) addon, with
byte-identical output.

## Install

```sh
npm install @btoon/js
```

## Usage

```js
import { encode, decode } from '@btoon/js';

const bytes = encode({ name: 'Alice', age: 30, active: true });
// Uint8Array: 83 a6 616374697665 c3 a3 616765 1e a4 6e616d65 a5 416c696365

decode(bytes); // { active: true, age: 30, name: 'Alice' }
```

CommonJS works the same way: `const { encode, decode } = require('@btoon/js')`.

In a browser without a bundler, import the ESM build directly (it has no `node:` imports):

```html
<script type="module">
  import { encode, decode } from './node_modules/@btoon/js/dist/esm/index.js';
</script>
```

[`examples/index.html`](examples/index.html) is a working page: run `npm run build`, serve
the repository (`make serve`, or `python3 -m http.server`), and open `/examples/`.

### Arrays of records become tables

Arrays of objects with the same keys are written column by column, with each key once,
whenever that is smaller (SPEC §5.6.2). They decode back to ordinary arrays of objects.

```js
const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `user${i}`, active: i % 2 === 0 }));
encode(rows).length;                         // 945 bytes
encode(rows, { autoTabular: false }).length; // 2493 bytes (plain MessagePack)
JSON.stringify(rows).length;                 // 4031 bytes
```

### Compression and signing

```js
import { encode, decode, encodeAsync, decodeAsync } from '@btoon/js';

const key = crypto.getRandomValues(new Uint8Array(32));

const sealed = encode(rows, { compress: true, hmacKey: key }); // Node.js: synchronous
decode(sealed, { hmacKey: key });

const sealed2 = await encodeAsync(rows, { compress: true, hmacKey: key }); // anywhere
await decodeAsync(sealed2, { hmacKey: key });
```

Envelopes are layered as sign(compress(document)). With `hmacKey`, `decode` requires a
signed envelope and verifies it in constant time before parsing; without a key, a signed
input is rejected rather than silently accepted. Compression is skipped for documents
under 256 bytes and whenever it would save less than 5% (SPEC §6).

## Environments

The package's `exports` map picks an entry point per environment. Both have the same
API; they differ only in which synchronous codecs are built in.

| | Node.js, Bun (`node` condition) | Browsers, Deno, workers, edge (`browser`, `deno`, `worker`, `workerd`, `edge-light`, default) |
|---|---|---|
| `decode` of zlib envelopes | `node:zlib` | built-in pure-JS inflate |
| `decode` of Brotli / Zstandard | `node:zlib` (Zstandard from Node.js 22.15) | `options.codecs` |
| `encode` with `compress` | zlib, Brotli, Zstandard via `node:zlib` | `options.codecs`, otherwise `unsupported_compression` (use `encodeAsync`) |
| HMAC in `encode`/`decode` | `node:crypto` | built-in pure-JS SHA-256 |
| `encodeAsync` compression | `CompressionStream` where the runtime supports the format, else `node:zlib` | `CompressionStream` where the runtime supports the format |
| `decodeAsync` decompression | `node:zlib` on its thread pool | the pure-JS inflate for zlib; Brotli through `DecompressionStream` where it proves strict (see below) |
| `encodeAsync` / `decodeAsync` HMAC | WebCrypto (`crypto.subtle`), else `node:crypto` | WebCrypto, else pure JS (for example on `http://` pages) |
| LZ4, Snappy | `options.codecs` | `options.codecs` |

`decodeAsync` accepts and rejects exactly what `decode` does, because it uses the same
decompressors: `node:zlib`'s asynchronous functions in the Node entry, and the pure-JS
inflate in the portable entry. Only where the portable entry has no decompressor of its
own (Brotli) does it use a `DecompressionStream`, and only after checking once that the
runtime rejects bytes after the end of a stream: Node.js 18 to 23 accept them after a zlib
stream (some later 22.x releases excepted), and Node.js 22 and 24 after a Brotli stream. Zstandard never goes through a
`DecompressionStream`, which can't limit the window size (SPEC §6). Which formats
`CompressionStream` supports depends on the runtime: at the time of writing, Brotli streams
exist in Node.js 22+ and Bun, and Zstandard streams in Bun.

Why a pure-JS inflate and SHA-256 in the portable entry: zlib decoding is mandatory in
the spec and signatures are a security feature, so synchronous `decode` handles both in
every environment. Together they add about 8.4 KB minified (3.6 KB gzipped). Inflate
enforces the declared output size as it goes, and its accept/reject decisions match zlib's
(tested differentially against `node:zlib`). Synchronous compression is not built in:
a good deflate encoder is large, and `encodeAsync` or a codec covers it.

### Custom codecs

`options.codecs` supplies or overrides compression algorithms. For example, synchronous
zlib compression in a browser with [fflate](https://github.com/101arrowz/fflate):

```js
import { zlibSync } from 'fflate';

const codecs = { zlib: { compress: (data) => zlibSync(data, { level: 6 }) } };
const bytes = encode(value, { compress: true, codecs });
```

A codec is `{ compress?(data), decompress?(data, uncompressedSize) }`. Either function may
return a `Promise`, but only the async API accepts one. `decompress` receives the size the
envelope declares (already checked against `maxDecompressedSize`) and must not produce
more than that. LZ4 block decoders need it as their output size.

## Type mapping

Encoding (JavaScript → BTOON):

| JavaScript | BTOON |
|---|---|
| `null`, `undefined` | nil (object properties and array holes holding `undefined` too) |
| `boolean` | boolean |
| `number` that is a safe integer | integer, smallest format |
| any other `number`, including `-0`, `NaN`, `±Infinity` and integral values beyond ±2^53 | float64 (NaN written as `7ff8000000000000`) |
| `bigint` | integer if within [-2^63, 2^64-1], else bigint extension |
| `string` | string (UTF-8). A lone surrogate throws `invalid_utf8` |
| `Uint8Array` (and `Buffer`), `ArrayBuffer`, `DataView`, other typed arrays | binary (the view's bytes) |
| `Float32Array`, `Float64Array` | float32 / float64 vector (little-endian, NaN bits preserved) |
| `Array` | array, or tabular when the size rule says so |
| plain object, `Map` with string keys | map, keys sorted by UTF-8 bytes |
| `Date` | timestamp (millisecond precision, UTC) |
| `Timestamp` | timestamp (nanoseconds, optional UTC offset) |
| `Ext` | extension, written as is |
| other objects | like `JSON.stringify`: the result of `toJSON()` if present (called once), else the object's own enumerable string-keyed properties. `Number`/`String`/`Boolean`/`BigInt` wrappers are unwrapped |
| functions, symbols | `invalid_argument` |

Decoding (BTOON → JavaScript):

| BTOON | JavaScript |
|---|---|
| nil | `null` |
| integer | `number` if a safe integer, else `bigint`. With `bigint: 'always'`, uint64/int64 markers and bigint extensions always give `bigint` |
| float | `number` |
| string | `string` |
| binary | `Uint8Array` (a copy, never a view of the input) |
| array, tabular | `Array` |
| map | plain object |
| timestamp, date, datetime | `Date` (milliseconds, offset dropped), or `Timestamp` with `timestamps: 'object'`. Instants outside the range of `Date` always give `Timestamp` |
| float32 / float64 vector | `Float32Array` / `Float64Array` (an aligned copy) |
| any other extension | `Ext` |

Notes:

- **Numbers.** JavaScript can't tell `2.0` from `2`, so whole numbers encode as integers.
  `-0` is the exception: it encodes as float64 `-0.0` so its sign survives.
- **`__proto__`.** A map key `"__proto__"` becomes an own property of the decoded object,
  as with `JSON.parse`. It never changes the object's prototype.
- **Key order.** Keys are sorted by their UTF-8 bytes, which is not JavaScript's default
  `sort()` order for characters outside the Basic Multilingual Plane.
- **`date` and `datetime`.** These extension types have no JavaScript type of their own and
  decode to `Date` (or `Timestamp`). To write one, use `new Ext(-2, bytes)` (int64
  milliseconds) or `new Ext(-3, bytes)` (int64 nanoseconds). An `Ext` with an id BTOON
  defines must carry a valid payload for that type, or `encode` throws `invalid_argument`.
- **Cycles** throw `max_depth`, like any value nested deeper than `maxDepth`.
- `Ext` and `Timestamp` are recognised through `Symbol.for('btoon.Ext')` and
  `Symbol.for('btoon.Timestamp')` brands, so instances from the ESM and CommonJS builds
  (or two copies of the package) are interchangeable.

## API

```ts
const VERSION: '0.1.2';
const SPEC_VERSION: '0.1';

function encode(value: unknown, options?: EncodeOptions): Uint8Array;
function decode(data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: DecodeOptions): unknown;
function encodeAsync(value: unknown, options?: EncodeOptions): Promise<Uint8Array>;
function decodeAsync(data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: DecodeOptions): Promise<unknown>;

class BtoonError extends Error { readonly code: BtoonErrorCode }
class Ext { constructor(readonly type: number, readonly data: Uint8Array) }
class Timestamp {
  constructor(seconds: bigint | number, nanoseconds: number, offsetMinutes?: number);
  readonly seconds: bigint; readonly nanoseconds: number; readonly offsetMinutes?: number;
  toDate(): Date;
  static fromDate(date: Date): Timestamp;
}
```

`encode` returns `Uint8Array<ArrayBuffer>`; the type definitions need TypeScript 5.7 or
later (or `skipLibCheck`). `decodeAsync` copies its input first, so the caller may reuse
the buffer right away. The async functions report every failure as a rejected promise.

### Encode options

| Option | Default | Meaning |
|---|---|---|
| `compress` | `false` | Wrap in a compression envelope. |
| `compression` | `'zlib'` | `'zlib'`, `'lz4'`, `'zstd'`, `'brotli'` or `'snappy'`. Only used when `compress` is true. |
| `autoTabular` | `true` | Use the tabular encoding where the size rule says so. |
| `maxDepth` | `128` | Nesting limit. Deeper or cyclic values throw `max_depth`. |
| `hmacKey` | none | `Uint8Array` or string (its UTF-8 bytes). Signs the output. Must not be empty. |
| `codecs` | none | Caller-supplied compression codecs. |

### Decode options

| Option | Default | Meaning |
|---|---|---|
| `strict` | `true` | SPEC §7 strict mode. `false` allows trailing bytes and duplicate map keys (last wins) and replaces invalid UTF-8 with U+FFFD. Bounds, depth, allocation and other structural checks are never relaxed. |
| `maxDepth` | `128` | Nesting limit. A tabular array counts two levels. |
| `maxDecompressedSize` | 256 MiB | Largest accepted `uncompressed_size`, checked before decompressing. |
| `autoDecompress` | `true` | Accept compression envelopes; `false` rejects them with `invalid_envelope`. |
| `hmacKey` | none | Require a signed envelope and verify it before parsing. Must not be empty. |
| `timestamps` | `'date'` | `'date'` or `'object'` (always `Timestamp`, full precision). |
| `bigint` | `'auto'` | `'auto'` or `'always'`. |
| `codecs` | none | Caller-supplied compression codecs. |

Invalid options throw `invalid_argument`. Unknown option names are ignored.

## Errors

Every failure is a `BtoonError` whose `code` is stable across BTOON implementations:

| Code | Meaning |
|---|---|
| `truncated` | Input ends before a value is complete, or a length runs past the input. |
| `invalid_marker` | The reserved byte `0xc1`. |
| `trailing_data` | Bytes after the top-level value (strict mode). |
| `invalid_utf8` | A string, key or column name isn't valid UTF-8, or a string to encode has a lone surrogate. |
| `non_string_key` | A map key that isn't a string. |
| `duplicate_key` | The same map key twice (strict mode). |
| `max_depth` | Nesting deeper than `maxDepth`, or a cyclic value. |
| `invalid_extension` | A malformed timestamp, date, datetime, bigint or vector payload. |
| `invalid_tabular` | A malformed tabular payload. |
| `invalid_envelope` | A malformed envelope, or a compressed payload that is corrupt, has trailing bytes, or decompresses to a size other than the declared one. |
| `size_limit` | A declared size above `maxDecompressedSize`, or a value too large for the engine. |
| `unsupported_compression` | An unknown algorithm id, or one not available in this environment. |
| `authentication_failed` | A missing or invalid signature, or a signed input decoded without a key. |
| `invalid_argument` | A value that can't be encoded, or an invalid option. |

```js
try {
  decode(bytes);
} catch (e) {
  if (e instanceof BtoonError && e.code === 'truncated') { /* … */ }
}
```

Exceptions thrown by your own `toJSON()` methods or getters propagate unchanged.

## Security

Decoding is designed for hostile input (SPEC §7, §9): every read is bounds-checked; arrays,
maps and tables are checked against the remaining input before anything is allocated, and
grow as their elements are decoded instead of reserving what their headers announce; the
nesting limit applies to input and output; strings are validated with a fatal
`TextDecoder`; compressed payloads are checked against `maxDecompressedSize` before
decompressing and stopped at their declared size while decompressing; Zstandard frames
whose window exceeds max(8 MiB, min(declared size, 128 MiB)) are rejected; HMACs are
compared in constant time and checked before the payload is parsed. Raising `maxDepth`
far above the default is safe: exhausting the JavaScript stack is reported as
`max_depth`.

## Conformance

The test suite runs btoon-core's conformance vectors (vendored in `test/vectors/`) against
the ESM and CommonJS builds of both entry points, synchronously and asynchronously: every
non-error vector must decode to its value, every canonical vector must re-encode
byte-for-byte, and every error vector must fail with its error code. All 260 pass, with
these exceptions:

- `float/0` is not re-encoded: the float `0.0` is indistinguishable from the integer `0`
  in JavaScript (it is still decoded and checked).
- Vectors that need an optional codec are skipped where it is missing: LZ4 everywhere;
  Brotli and Zstandard in the portable entry without `codecs` (and Zstandard on
  Node.js < 22.15).

## Performance

Measured with `npm run bench` (Node.js 22.22.2, Apple M4 Max, best of 7 rounds; Node
entry). Throughput is relative to the BTOON size. JSON figures are for comparison only.

| Case | BTOON size | encode | decode | JSON size | `JSON.stringify` | `JSON.parse` |
|---|---|---|---|---|---|---|
| 10k records, tabular | 571,851 B | 1.54 ms | 2.92 ms | 1,242,300 B | 2.01 ms | 2.80 ms |
| 10k records, `autoTabular: false` | 941,744 B | 3.76 ms | 3.97 ms | 1,242,300 B | 2.01 ms | 2.81 ms |
| 2k nested objects | 177,644 B | 0.74 ms | 0.66 ms | 298,714 B | 0.63 ms | 0.96 ms |

The portable entry measured up to 6% slower than these numbers on the same machine.

Bundle size of the portable ESM entry with everything imported, bundled with esbuild
0.28.2 (`--minify`): 44.1 KB, 14.7 KB gzipped. An application that imports only `decode`
bundles 25.9 KB (9.4 KB gzipped).

## Development

```sh
npm install
npm run build       # dist/esm and dist/cjs, each with .d.ts files (tsc)
npm run typecheck   # strict type check of src/
npm test            # node:test suite against dist/ (vectors, unit, fuzz, packaging)
npm run bench
npm run vectors:sync  # re-copy the vectors from ../btoon-core (or a path argument)
```

`npm test -- fuzz vectors` runs only the matching test files. `FUZZ_ITERATIONS`,
`FUZZ_SEED`, `INFLATE_MUTATIONS` and `CANONICAL_ITERATIONS` scale the randomized tests.
The `Makefile` wraps the same commands. CI runs type checking, the build and the tests on
Node.js 20, 22, 24 and 26.

Never edit `test/vectors/btoon-vectors.json` by hand: it is generated by btoon-core's
`tests/vectors/generate.py`.

## License

MIT. See [LICENSE](LICENSE).
