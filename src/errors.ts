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
  /**
   * A size above a configured limit: an envelope's declared size, or a table's copied column
   * names, above `maxDecompressedSize`; more values than `maxValues`; or a value too large
   * for the JavaScript engine.
   */
  | 'size_limit'
  /** A compression algorithm that is unknown or not available in this environment. */
  | 'unsupported_compression'
  /** HMAC verification failed, a signature was required but missing, or a signed input arrived without a key. */
  | 'authentication_failed'
  /**
   * A value that cannot be encoded (including an `Ext` with an id BTOON defines), or an
   * invalid option (including an empty or `null` `hmacKey`, or `maxDepth` above 1000).
   */
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
 * True for the engine's "too much recursion" error. `maxDepth` is at most 1000, which fits
 * the default stack, but a call that starts with little stack left (deep recursion in the
 * caller, a worker with a small stack) can still run out before the depth limit triggers;
 * that case is reported as `max_depth` instead of leaking a RangeError.
 */
export function isStackOverflow(e: unknown): boolean {
  if (e instanceof BtoonError) return false;
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: unknown; message?: unknown };
  if (err.name !== 'RangeError' && err.name !== 'InternalError') return false;
  if (typeof err.message !== 'string') return false;
  // No regular expression: this runs when the stack ran out, and V8 compiles a regular
  // expression on first use, which then fails with a SyntaxError ("Stack overflow").
  const message = err.message.toLowerCase();
  return message.includes('call stack') || message.includes('recursion');
}
