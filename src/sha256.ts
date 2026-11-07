// SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) for runtimes without a synchronous
// native implementation. Used only for the signed envelope (SPEC §8).

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

class Sha256 {
  private readonly h = new Int32Array(IV);
  private readonly w = new Int32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private total = 0;

  update(data: Uint8Array): this {
    let i = 0;
    const n = data.length;
    this.total += n;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, n);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen < 64) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.compress(data, i);
    if (i < n) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = n - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const block = this.block;
    block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      block.fill(0, this.blockLen);
      this.compress(block, 0);
      this.blockLen = 0;
    }
    block.fill(0, this.blockLen, 56);
    const view = new DataView(block.buffer);
    view.setUint32(56, Math.floor(bits / 4294967296));
    view.setUint32(60, bits >>> 0);
    this.compress(block, 0);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let j = 0; j < 8; j++) ov.setInt32(j * 4, this.h[j]!);
    return out;
  }

  private compress(d: Uint8Array, p: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++, p += 4) w[j] = (d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!;
    for (let j = 16; j < 64; j++) {
      const a = w[j - 15]!;
      const b = w[j - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) | 0;
    }
    const h = this.h;
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let d0 = h[3]!;
    let hh = h[7]!;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[j]! + w[j]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d0 + t1) | 0;
      d0 = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d0) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

/** HMAC-SHA256 over the concatenation of `parts` (no copy of the parts is made). */
export function hmacSha256(key: Uint8Array, parts: readonly Uint8Array[]): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key;
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i]! : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const inner = new Sha256().update(ipad);
  for (const p of parts) inner.update(p);
  return new Sha256().update(opad).update(inner.digest()).digest();
}

/** Compares two byte strings in time that depends only on their length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
