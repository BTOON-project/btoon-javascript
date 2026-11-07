// Compile-only: exercises the published .d.ts files the way a consumer would. Checked by
// test/package.test.mjs with `moduleResolution` NodeNext and Bundler.
import {
  BtoonError,
  Ext,
  SPEC_VERSION,
  Timestamp,
  VERSION,
  decode,
  decodeAsync,
  encode,
  encodeAsync,
  type BinaryInput,
  type BtoonErrorCode,
  type Codec,
  type CodecRegistry,
  type CompressionAlgorithm,
  type DecodeOptions,
  type EncodeOptions,
} from '@btoon/js';

const version: '0.1.1' = VERSION;
const spec: '0.1' = SPEC_VERSION;

const bytes: Uint8Array<ArrayBuffer> = encode({ a: 1, b: [true, null], when: new Date() });
// The result is a plain ArrayBuffer-backed view, usable wherever a BufferSource is expected.
const body: BodyInit = bytes;
const blob = new Blob([bytes]);
const value: unknown = decode(bytes);
decode(bytes.buffer);
decode(new DataView(bytes.buffer));
const input: BinaryInput = new Int16Array(4);
decode(input, { strict: false, maxDepth: 10, timestamps: 'object', bigint: 'always' });

const codec: Codec = {
  compress: (d: Uint8Array) => d,
  decompress: async (d: Uint8Array, size: number) => d.subarray(0, size),
};
const codecs: CodecRegistry = { lz4: codec, snappy: { decompress: (d) => d } };
const algorithm: CompressionAlgorithm = 'zstd';
const encodeOptions: EncodeOptions = {
  compress: true,
  compression: algorithm,
  autoTabular: false,
  maxDepth: 64,
  hmacKey: 'secret',
  codecs,
};
const decodeOptions: DecodeOptions = {
  maxDecompressedSize: 1 << 20,
  autoDecompress: true,
  hmacKey: new Uint8Array(32),
  codecs,
};
// @ts-expect-error: not a supported algorithm
const badAlgorithm: EncodeOptions = { compression: 'gzip' };
// @ts-expect-error: not a timestamps mode
const badMode: DecodeOptions = { timestamps: 'iso' };

async function roundTrip(): Promise<unknown> {
  const packed: Uint8Array<ArrayBuffer> = await encodeAsync(value, encodeOptions);
  return decodeAsync(packed, decodeOptions);
}

try {
  decode(new Uint8Array([0xc1]));
} catch (e) {
  if (e instanceof BtoonError) {
    const code: BtoonErrorCode = e.code;
    const message: string = e.message;
    void code;
    void message;
  }
}
// @ts-expect-error: not an error code
new BtoonError('nope', 'x');
const err = new BtoonError('invalid_argument', 'x', { cause: new Error('inner') });

const ts = new Timestamp(1704067200n, 500, -330);
const ts2 = new Timestamp(0, 0);
const seconds: bigint = ts.seconds;
const nanos: number = ts.nanoseconds;
const offset: number | undefined = ts.offsetMinutes;
const date: Date = ts.toDate();
const fromDate: Timestamp = Timestamp.fromDate(new Date(0));
const ext = new Ext(42, new Uint8Array([1, 2, 3]));
const extType: number = ext.type;
const extData: Uint8Array = ext.data;

export {
  badAlgorithm,
  badMode,
  blob,
  body,
  date,
  err,
  extData,
  extType,
  fromDate,
  nanos,
  offset,
  roundTrip,
  seconds,
  spec,
  ts2,
  version,
};
