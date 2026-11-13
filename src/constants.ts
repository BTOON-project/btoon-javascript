/** Version of this library. */
export const VERSION = '0.1.2' as const;

/** Version of the BTOON specification this library implements. */
export const SPEC_VERSION = '0.1' as const;

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

export const DEFAULT_MAX_DEPTH = 128;
export const DEFAULT_MAX_DECOMPRESSED_SIZE = 256 * 1024 * 1024;

/** Encoders SHOULD skip compression below this size (SPEC §6). */
export const MIN_COMPRESSION_SIZE = 256;

export const COMPRESSION_HEADER_SIZE = 16;
export const SIGNED_HEADER_SIZE = 40;

/** Compression algorithm ids of the envelope header (SPEC §6). */
export const ALGORITHM_IDS = { zlib: 0, lz4: 1, zstd: 2, brotli: 3, snappy: 4 } as const;
export const ALGORITHM_NAMES = ['zlib', 'lz4', 'zstd', 'brotli', 'snappy'] as const;

/** Brands that identify {@link Ext} and {@link Timestamp} instances across module copies. */
export const EXT_BRAND: unique symbol = Symbol.for('btoon.Ext') as never;
export const TIMESTAMP_BRAND: unique symbol = Symbol.for('btoon.Timestamp') as never;

/** Date's representable range is ±8.64e15 ms around the epoch. */
export const MAX_DATE_MS = 8_640_000_000_000_000;
