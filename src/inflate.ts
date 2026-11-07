// A small, bounded zlib (RFC 1950) / DEFLATE (RFC 1951) decoder for runtimes without a
// synchronous native one (browsers, Deno, edge workers). It accepts exactly what zlib's
// inflate accepts (same rules for incomplete and over-subscribed Huffman codes, distance
// limits and the Adler-32 trailer), rejects trailing bytes after the stream, and never
// writes past the declared output size. Work per input byte is bounded: Huffman tables
// cost at most 512 entries to build, and longer codes are decoded bit by bit.
import { fail } from './errors.js';

const FAST_BITS = 9;
const FAST_SIZE = 1 << FAST_BITS;
const FAST_MASK = FAST_SIZE - 1;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function corrupt(what: string): Error {
  return fail('invalid_envelope', `zlib payload ${what}`);
}

/** Canonical Huffman code: counts per length, symbols in canonical order, a 9-bit fast table. */
class Huffman {
  readonly count = new Uint16Array(16);
  readonly symbol: Uint16Array;
  /** Indexed by the next 9 input bits: (symbol << 4) | length, or 0 for "decode slowly". */
  readonly fast = new Uint16Array(FAST_SIZE);
  /** Longest code length in use (0 = no codes). */
  max = 0;

  constructor(n: number) {
    this.symbol = new Uint16Array(n);
  }

  /** Builds from `n` code lengths; returns unused code space (0 = complete, < 0 = over-subscribed). */
  build(lengths: Uint8Array, offset: number, n: number): number {
    const count = this.count;
    count.fill(0);
    for (let i = 0; i < n; i++) count[lengths[offset + i]!]!++;
    count[0] = 0;
    let max = 0;
    let left = 1;
    for (let len = 1; len <= 15; len++) {
      left <<= 1;
      left -= count[len]!;
      if (left < 0) return left;
      if (count[len]) max = len;
    }
    this.max = max;
    const offs = new Uint16Array(16);
    for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
    for (let sym = 0; sym < n; sym++) {
      const len = lengths[offset + sym]!;
      if (len) this.symbol[offs[len]!++] = sym;
    }
    const fast = this.fast;
    fast.fill(0);
    let code = 0;
    let idx = 0;
    for (let len = 1; len <= FAST_BITS; len++) {
      for (let k = count[len]!; k > 0; k--) {
        let rev = 0;
        for (let b = 0; b < len; b++) rev |= ((code >> b) & 1) << (len - 1 - b);
        const entry = (this.symbol[idx]! << 4) | len;
        for (let j = rev; j < FAST_SIZE; j += 1 << len) fast[j] = entry;
        idx++;
        code++;
      }
      code <<= 1;
    }
    return left;
  }
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (fixedLit === null || fixedDist === null) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    fixedLit = new Huffman(288);
    fixedLit.build(l, 0, 288);
    const d = new Uint8Array(30).fill(5);
    fixedDist = new Huffman(30);
    fixedDist.build(d, 0, 30); // incomplete (30 of 32 codes), as in zlib
  }
  return [fixedLit, fixedDist];
}

class Inflater {
  private readonly input: Uint8Array;
  private inPos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  out: Uint8Array;
  outPos = 0;
  private readonly limit: number;

  constructor(input: Uint8Array, limit: number) {
    this.input = input;
    this.limit = limit;
    this.out = new Uint8Array(Math.min(limit, Math.max(64 * 1024, input.length * 4)));
  }

  private bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.inPos >= this.input.length) throw corrupt('is truncated');
      this.bitBuf |= this.input[this.inPos++]! << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }

  /** Next Huffman symbol, or -1 if the bits match no code. */
  private sym(h: Huffman): number {
    while (this.bitCnt < FAST_BITS && this.inPos < this.input.length) {
      this.bitBuf |= this.input[this.inPos++]! << this.bitCnt;
      this.bitCnt += 8;
    }
    const e = h.fast[this.bitBuf & FAST_MASK]!;
    const len = e & 15;
    if (len !== 0) {
      if (len > this.bitCnt) throw corrupt('is truncated');
      this.bitBuf >>>= len;
      this.bitCnt -= len;
      return e >> 4;
    }
    // Longer code (or none): canonical decoding, one bit at a time.
    const count = h.count;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let l = 1; l <= 15; l++) {
      code |= this.bits(1);
      const c = count[l]!;
      if (code - first < c) return h.symbol[index + code - first]!;
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    return -1;
  }

  private room(n: number): void {
    const need = this.outPos + n;
    if (need <= this.out.length) return;
    if (need > this.limit) throw corrupt('decompresses to more than the declared size');
    const next = new Uint8Array(Math.min(this.limit, Math.max(this.out.length * 2, need)));
    next.set(this.out.subarray(0, this.outPos));
    this.out = next;
  }

  /** Byte-aligns the bit reader and hands back whole bytes it had buffered. */
  private align(): void {
    this.inPos -= this.bitCnt >> 3;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  private stored(): void {
    this.align();
    const inp = this.input;
    const p = this.inPos;
    if (p + 4 > inp.length) throw corrupt('is truncated');
    const len = inp[p]! | (inp[p + 1]! << 8);
    const nlen = inp[p + 2]! | (inp[p + 3]! << 8);
    if (len !== (~nlen & 0xffff)) throw corrupt('is corrupt (invalid stored block lengths)');
    if (p + 4 + len > inp.length) throw corrupt('is truncated');
    this.room(len);
    this.out.set(inp.subarray(p + 4, p + 4 + len), this.outPos);
    this.outPos += len;
    this.inPos = p + 4 + len;
  }

  private dynamic(lit: Huffman, dist: Huffman, cl: Huffman, lens: Uint8Array): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw corrupt('is corrupt (too many length or distance symbols)');
    const clLens = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) clLens[CL_ORDER[i]!] = this.bits(3);
    if (cl.build(clLens, 0, 19) !== 0) throw corrupt('is corrupt (invalid code lengths set)');
    const total = nlen + ndist;
    let i = 0;
    while (i < total) {
      const s = this.sym(cl);
      if (s < 16) {
        if (s < 0) throw corrupt('is corrupt (invalid code lengths set)');
        lens[i++] = s;
        continue;
      }
      let rep: number;
      let val = 0;
      if (s === 16) {
        if (i === 0) throw corrupt('is corrupt (invalid bit length repeat)');
        val = lens[i - 1]!;
        rep = 3 + this.bits(2);
      } else if (s === 17) {
        rep = 3 + this.bits(3);
      } else {
        rep = 11 + this.bits(7);
      }
      if (i + rep > total) throw corrupt('is corrupt (invalid bit length repeat)');
      while (rep-- > 0) lens[i++] = val;
    }
    if (lens[256] === 0) throw corrupt('is corrupt (missing end-of-block code)');
    // Incomplete codes are allowed only when they consist of a single 1-bit code (zlib).
    let left = lit.build(lens, 0, nlen);
    if (left < 0 || (left > 0 && lit.max !== 1)) throw corrupt('is corrupt (invalid literal/lengths set)');
    left = dist.build(lens, nlen, ndist);
    if (left < 0 || (left > 0 && dist.max > 1)) throw corrupt('is corrupt (invalid distances set)');
    this.codes(lit, dist);
  }

  private codes(lit: Huffman, dist: Huffman): void {
    for (;;) {
      let s = this.sym(lit);
      if (s < 256) {
        if (s < 0) throw corrupt('is corrupt (invalid literal/length code)');
        if (this.outPos >= this.out.length) this.room(1);
        this.out[this.outPos++] = s;
        continue;
      }
      if (s === 256) return;
      s -= 257;
      if (s >= 29) throw corrupt('is corrupt (invalid literal/length code)');
      const len = LEN_BASE[s]! + this.bits(LEN_EXTRA[s]!);
      const ds = this.sym(dist);
      if (ds < 0 || ds >= 30) throw corrupt('is corrupt (invalid distance code)');
      const d = DIST_BASE[ds]! + this.bits(DIST_EXTRA[ds]!);
      if (d > this.outPos) throw corrupt('is corrupt (invalid distance too far back)');
      this.room(len);
      const out = this.out;
      let to = this.outPos;
      let from = to - d;
      if (d >= len && len > 16) {
        out.copyWithin(to, from, from + len);
        to += len;
      } else {
        for (const end = to + len; to < end; ) out[to++] = out[from++]!;
      }
      this.outPos = to;
    }
  }

  run(): Uint8Array {
    const inp = this.input;
    if (inp.length < 2) throw corrupt('is truncated');
    const cmf = inp[0]!;
    const flg = inp[1]!;
    if (((cmf << 8) | flg) % 31 !== 0) throw corrupt('is corrupt (incorrect header check)');
    if ((cmf & 0x0f) !== 8) throw corrupt('is corrupt (unknown compression method)');
    if (cmf >> 4 > 7) throw corrupt('is corrupt (invalid window size)');
    if (flg & 0x20) throw corrupt('needs a preset dictionary, which BTOON does not support');
    this.inPos = 2;
    let lit: Huffman | null = null;
    let dist: Huffman | null = null;
    let cl: Huffman | null = null;
    let lens: Uint8Array | null = null;
    let last = 0;
    while (!last) {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) {
        this.stored();
      } else if (type === 1) {
        const [fl, fd] = fixedTables();
        this.codes(fl, fd);
      } else if (type === 2) {
        if (lit === null) {
          lit = new Huffman(286);
          dist = new Huffman(30);
          cl = new Huffman(19);
          lens = new Uint8Array(286 + 30);
        }
        this.dynamic(lit, dist!, cl!, lens!);
      } else {
        throw corrupt('is corrupt (invalid block type)');
      }
    }
    this.align();
    const p = this.inPos;
    if (p + 4 > inp.length) throw corrupt('is truncated');
    const expected = ((inp[p]! << 24) | (inp[p + 1]! << 16) | (inp[p + 2]! << 8) | inp[p + 3]!) >>> 0;
    if (adler32(this.out, 0, this.outPos) !== expected) throw corrupt('is corrupt (incorrect data check)');
    if (p + 4 !== inp.length) throw corrupt('has trailing bytes');
    return this.out.subarray(0, this.outPos);
  }
}

/**
 * Decompresses an RFC 1950 zlib stream that must expand to at most `limit` bytes. Throws
 * `invalid_envelope` for corrupt or truncated input, trailing bytes after the stream, or
 * output beyond `limit`. The output buffer grows geometrically, so a lying size header
 * cannot force a large allocation for a small input.
 */
export function inflateZlib(input: Uint8Array, limit: number): Uint8Array {
  return new Inflater(input, limit).run();
}

/** Adler-32 checksum of `d[start, end)` (RFC 1950). */
export function adler32(d: Uint8Array, start = 0, end = d.length): number {
  let a = 1;
  let b = 0;
  let i = start;
  while (i < end) {
    const stop = Math.min(end, i + 3800); // keeps b below 2^31 between reductions
    for (; i < stop; i++) {
      a += d[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
