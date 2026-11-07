/**
 * Machine-readable error codes. All but `invalid_argument` are the decoder error codes
 * of SPEC §7; `invalid_argument` reports a value or option the library cannot accept.
 */
export type BtoonErrorCode =
  /** Input ends before a value is complete, or a length runs past the input. */
  | 'truncated'
  /** The reserved marker byte `0xc1`. */
  | 'invalid_marker'
  /** Bytes remain after the top-level value (strict mode). */
  | 'trailing_data'
  /** A string, map key or column name is not well-formed UTF-8 (or, when encoding, a string contains a lone surrogate). */
  | 'invalid_utf8'
  /** A map key is not a string. */
  | 'non_string_key'
  /** A map contains the same key twice (strict mode). */
  | 'duplicate_key'
  /** Nesting deeper than `maxDepth`, or a cyclic value. */
  | 'max_depth'
  /** A malformed BTOON extension payload (timestamp, date, datetime, bigint, vectors). */
  | 'invalid_extension'
  /** A malformed tabular payload. */
  | 'invalid_tabular'
  /** A malformed compression or signed envelope, or a corrupt compressed payload. */
  | 'invalid_envelope'
  /** A size above a configured limit (for example `maxDecompressedSize`). */
  | 'size_limit'
  /** A compression algorithm that is unknown or not available in this environment. */
  | 'unsupported_compression'
  /** HMAC verification failed, a signature was required but missing, or a signed input arrived without a key. */
  | 'authentication_failed'
  /** A value that cannot be encoded, or an invalid option. */
  | 'invalid_argument';

/**
 * The only error type thrown by this library's `encode`/`decode` functions (and the only
 * rejection reason of the async variants). Branch on {@link BtoonError.code}, which is
 * stable across BTOON implementations; the message is for humans and may change.
 */
export class BtoonError extends Error {
  /** Machine-readable error code (SPEC §7, plus `invalid_argument`). */
  readonly code: BtoonErrorCode;

  constructor(code: BtoonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BtoonError';
    this.code = code;
    if (options !== undefined && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

/** Shorthand used internally: `throw fail('truncated', '...')`. */
export function fail(code: BtoonErrorCode, message: string, cause?: unknown): BtoonError {
  return cause === undefined ? new BtoonError(code, message) : new BtoonError(code, message, { cause });
}

/**
 * True for the engine's "too much recursion" error. Raising `maxDepth` far above the
 * default can exhaust the JavaScript call stack before the depth limit triggers; that
 * case is reported as `max_depth` instead of leaking a RangeError.
 */
export function isStackOverflow(e: unknown): boolean {
  if (e instanceof BtoonError) return false;
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: unknown; message?: unknown };
  if (err.name !== 'RangeError' && err.name !== 'InternalError') return false;
  return typeof err.message === 'string' && /call stack|recursion/i.test(err.message);
}
