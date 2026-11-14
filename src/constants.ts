/** Version of this library. */
export const VERSION = '0.3.0' as const;

/** Version of the BTOON specification this library implements. */
export const SPEC_VERSION = '0.3' as const;

// Extension type ids (SPEC §5).
export const EXT_TIMESTAMP = -1;
export const EXT_DATE = -2;
export const EXT_DATETIME = -3;
export const EXT_BIGINT = -4;
export const EXT_F32_VECTOR = -5;
export const EXT_F64_VECTOR = -6;
export const EXT_TABULAR = -10;

export const TABULAR_VERSION = 1;
export const MAX_OFFSET_MINUTES = 1080;
export const NANOS_PER_SECOND = 1_000_000_000;

// Resource limits (SPEC §7.1).
export const DEFAULT_MAX_DEPTH = 128;
/** The largest `maxDepth` a caller may set (SPEC §7); a deeper limit could exhaust the stack. */
export const MAX_DEPTH_LIMIT = 1000;
export const DEFAULT_MAX_DECOMPRESSED_SIZE = 64 * 1024 * 1024;
export const DEFAULT_MAX_VALUES = 2 ** 20;

/** Encoders SHOULD skip compression below this size (SPEC §6). */
export const MIN_COMPRESSION_SIZE = 256;

export const COMPRESSION_HEADER_SIZE = 16;
export const SIGNED_HEADER_SIZE = 40;

/** Compression algorithm ids of the envelope header (SPEC §6). */
export const ALGORITHM_IDS = { zlib: 0, lz4: 1, zstd: 2, brotli: 3, snappy: 4 } as const;
export const ALGORITHM_NAMES = ['zlib', 'lz4', 'zstd', 'brotli', 'snappy'] as const;

/**
 * Brands that identify this library's classes across module copies (the CommonJS and ESM
 * builds, bundled duplicates, other realms) and the native `btoon` package, which uses the
 * same ones. `instanceof` checks them (`Symbol.hasInstance`), and so does the encoder.
 */
export const EXT_BRAND: unique symbol = Symbol.for('btoon.Ext') as never;
export const TIMESTAMP_BRAND: unique symbol = Symbol.for('btoon.Timestamp') as never;
export const DATE_BRAND: unique symbol = Symbol.for('btoon.Date') as never;
export const DATETIME_BRAND: unique symbol = Symbol.for('btoon.DateTime') as never;
export const ERROR_BRAND: unique symbol = Symbol.for('btoon.BtoonError') as never;

/** Date's representable range is ±8.64e15 ms around the epoch. */
export const MAX_DATE_MS = 8_640_000_000_000_000;
