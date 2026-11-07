import { fail } from './errors.js';

export const textEncoder = new TextEncoder();
// ignoreBOM: true keeps a leading U+FEFF instead of silently stripping it.
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

const LONE_SURROGATE = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const HAS_SURROGATE = /[\uD800-\uDFFF]/;

type WellFormedString = string & { isWellFormed?: () => boolean };
const nativeIsWellFormed = typeof (String.prototype as { isWellFormed?: unknown }).isWellFormed === 'function';

/** True if `s` has no lone surrogates, i.e. it can be encoded as UTF-8 losslessly. */
export function isWellFormed(s: string): boolean {
  if (nativeIsWellFormed) return (s as WellFormedString).isWellFormed!();
  return !HAS_SURROGATE.test(s) || !LONE_SURROGATE.test(s);
}

export function loneSurrogateError(): Error {
  return fail('invalid_utf8', 'string contains a lone surrogate and cannot be encoded as UTF-8');
}

/** Exact UTF-8 byte length of `s`; throws `invalid_utf8` for a lone surrogate. */
export function utf8Length(s: string): number {
  const n = s.length;
  let bytes = n;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      bytes += 1;
    } else if (c < 0xd800 || c > 0xdfff) {
      bytes += 2;
    } else {
      const d = c <= 0xdbff && i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) throw loneSurrogateError();
      i++;
      bytes += 2; // 4 bytes for 2 code units
    }
  }
  return bytes;
}

/**
 * Orders strings by their UTF-8 bytes (SPEC §4.4), which equals code point order. Plain
 * `<` compares UTF-16 code units, which puts astral characters (surrogate pairs,
 * U+D800–U+DFFF) before U+E000–U+FFFF; this corrects exactly that case.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800 && y >= 0xd800) {
        const xs = x <= 0xdfff;
        const ys = y <= 0xdfff;
        if (xs !== ys) return xs ? 1 : -1;
      }
      return x - y;
    }
  }
  return a.length - b.length;
}

const fromCharCode = String.fromCharCode;

/**
 * Decodes `length` bytes at `start`. Strict mode rejects ill-formed UTF-8 (RFC 3629:
 * overlongs, surrogates, > U+10FFFF, truncated sequences) via TextDecoder's fatal mode;
 * non-strict mode substitutes U+FFFD. Returns `undefined` for invalid input so the caller
 * can report the position.
 */
export function decodeUtf8(bytes: Uint8Array, start: number, length: number, strict: boolean): string | undefined {
  if (length <= 32) {
    // Short ASCII: one pass, no TextDecoder call.
    let s = '';
    let i = start;
    const end = start + length;
    for (; i < end; i++) {
      const b = bytes[i]!;
      if (b >= 0x80) break;
      s += fromCharCode(b);
    }
    if (i === end) return s;
  }
  const view = bytes.subarray(start, start + length);
  try {
    return (strict ? fatalDecoder : lenientDecoder).decode(view);
  } catch (e) {
    // The fatal decoder reports ill-formed input as a TypeError; anything else is the
    // engine refusing to build a string that large.
    if (strict && e instanceof TypeError) return undefined;
    throw fail('size_limit', 'string is too long for this JavaScript engine', e);
  }
}
