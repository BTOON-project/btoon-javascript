// JavaScript ↔ BTOON type mapping (IMPLEMENTATION-GUIDE §5) and the JS-specific rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { builds, hex, unhex } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

for (const name of ['esm/node', 'esm/portable']) {
  const lib = builds[name];
  const { encode, decode, Ext, Timestamp, BtoonError } = lib;
  const enc = (v, o) => hex(encode(v, o));
  const dec = (h, o) => decode(unhex(h.replace(/\s+/g, '')), o);
  const throwsCode = (fn, code) =>
    assert.throws(fn, (e) => {
      assert.ok(e instanceof BtoonError, `expected BtoonError, got ${e}`);
      assert.equal(e.code, code, e.message);
      return true;
    });

  describe(`${name}: constants and errors`, () => {
    test('VERSION and SPEC_VERSION', () => {
      assert.equal(lib.VERSION, pkg.version);
      assert.equal(lib.SPEC_VERSION, '0.2');
    });
    test('BtoonError shape', () => {
      try {
        dec('c1');
        assert.fail('no error');
      } catch (e) {
        assert.ok(e instanceof BtoonError);
        assert.ok(e instanceof Error);
        assert.equal(e.name, 'BtoonError');
        assert.equal(e.code, 'invalid_marker');
        assert.match(e.message, /at byte 0/);
      }
      const e = new BtoonError('size_limit', 'x', { cause: 42 });
      assert.equal(e.cause, 42);
    });
  });

  describe(`${name}: numbers`, () => {
    test('safe integers use the smallest format', () => {
      const cases = [
        [0, '00'], [127, '7f'], [128, 'cc80'], [255, 'ccff'], [256, 'cd0100'], [65535, 'cdffff'],
        [65536, 'ce00010000'], [2 ** 32 - 1, 'ceffffffff'], [2 ** 32, 'cf0000000100000000'],
        [Number.MAX_SAFE_INTEGER, 'cf001fffffffffffff'], [-1, 'ff'], [-32, 'e0'], [-33, 'd0df'],
        [-128, 'd080'], [-129, 'd1ff7f'], [-32768, 'd18000'], [-32769, 'd2ffff7fff'],
        [-(2 ** 31), 'd280000000'], [-(2 ** 31) - 1, 'd3ffffffff7fffffff'],
        [Number.MIN_SAFE_INTEGER, 'd3ffe0000000000001'],
      ];
      for (const [v, h] of cases) {
        assert.equal(enc(v), h, String(v));
        assert.equal(dec(h), v);
      }
    });
    test('-0 keeps its sign as float64; other non-integers are float64; NaN is canonical', () => {
      assert.equal(enc(-0), 'cb8000000000000000');
      assert.ok(Object.is(dec('cb8000000000000000'), -0));
      assert.equal(enc(0), '00');
      assert.equal(enc(1.5), 'cb3ff8000000000000');
      assert.equal(enc(Infinity), 'cb7ff0000000000000');
      assert.equal(enc(-Infinity), 'cbfff0000000000000');
      assert.equal(enc(NaN), 'cb7ff8000000000000');
      const weird = new Float64Array(new BigUint64Array([0x7ff0000000000123n]).buffer)[0];
      assert.ok(Number.isNaN(weird));
      assert.equal(enc(weird), 'cb7ff8000000000000');
      assert.equal(enc(2 ** 53), 'cb4340000000000000', 'integral but unsafe → float64');
      assert.equal(enc(1e300), 'cb7e37e43c8800759c');
    });
    test('bigint encodes as an integer when it fits 64 bits, else as ext -4', () => {
      assert.equal(enc(5n), '05');
      assert.equal(enc(-5n), 'fb');
      assert.equal(enc(2n ** 53n), 'cf0020000000000000');
      assert.equal(enc(2n ** 64n - 1n), 'cfffffffffffffffff');
      assert.equal(enc(-(2n ** 63n)), 'd38000000000000000');
      assert.equal(enc(2n ** 64n), 'c709fc010000000000000000');
      assert.equal(enc(-(2n ** 63n) - 1n), 'c709fcff7fffffffffffffff');
      assert.equal(enc(2n ** 71n), 'c70afc00800000000000000000', 'sign byte added when the top bit is set');
      assert.equal(enc(-(2n ** 71n)), 'c709fc800000000000000000');
      assert.equal(enc(-(2n ** 71n) - 1n), 'c70afcff7fffffffffffffffff');
      for (const v of [2n ** 64n, -(2n ** 64n), 10n ** 40n, -(10n ** 40n), 2n ** 200n + 12345n]) {
        assert.equal(dec(enc(v)), v);
      }
    });
    test("decoding: safe integers → number, beyond → bigint; bigint: 'always' for 64-bit markers", () => {
      assert.equal(dec('cf001fffffffffffff'), Number.MAX_SAFE_INTEGER);
      assert.equal(dec('cf0020000000000000'), 2n ** 53n);
      assert.equal(dec('d3ffe0000000000001'), Number.MIN_SAFE_INTEGER);
      assert.equal(dec('d3ffe0000000000000'), -(2n ** 53n));
      assert.equal(dec('cfffffffffffffffff'), 2n ** 64n - 1n);
      assert.equal(dec('d38000000000000000'), -(2n ** 63n));
      assert.equal(dec('cf0000000000000005', { bigint: 'always' }), 5n);
      assert.equal(dec('d3fffffffffffffffb', { bigint: 'always' }), -5n);
      assert.equal(dec('ce00000005', { bigint: 'always' }), 5);
      assert.equal(dec('c701fc05'), 5, 'a small bigint extension is the same logical integer');
      assert.equal(dec('c701fc05', { bigint: 'always' }), 5n);
      assert.equal(dec('c703fcffff80'), -128);
    });
  });

  describe(`${name}: strings`, () => {
    test('UTF-8 header boundaries count bytes, not UTF-16 units', () => {
      assert.equal(enc('é'.repeat(15)).slice(0, 2), 'be', '30 bytes → fixstr');
      assert.equal(enc('é'.repeat(16)).slice(0, 4), 'd920', '32 bytes → str8');
      assert.equal(enc('x'.repeat(31)).slice(0, 2), 'bf');
      assert.equal(enc('x'.repeat(32)).slice(0, 4), 'd920');
      assert.equal(enc('é'.repeat(100)).slice(0, 4), 'd9c8', '200 bytes: header shrunk from str16 to str8');
      assert.equal(enc('x'.repeat(256)).slice(0, 6), 'da0100');
      assert.equal(enc('€'.repeat(30000)).slice(0, 10), 'db00015f90', '90000 bytes → str32');
      for (const s of ['', 'a', 'é', '日本語', '🎉', 'Grüße, 世界! 🚀', 'x'.repeat(70000), '🎉'.repeat(40), '\u{10FFFF}']) {
        assert.equal(dec(enc(s)), s);
      }
    });
    test('lone surrogates are rejected rather than silently replaced', () => {
      for (const s of ['\uD800', 'a\uDC00', '\uDBFFx', 'x'.repeat(40) + '\uD83D', '\uDE00' + 'y'.repeat(50)]) {
        throwsCode(() => encode(s), 'invalid_utf8');
        throwsCode(() => encode({ [s]: 1 }), 'invalid_utf8');
      }
    });
    test('a leading byte-order mark is preserved', () => {
      assert.equal(dec(enc('﻿abc')), '﻿abc');
      assert.equal(dec('a6efbbbf616263'), '﻿abc');
    });
  });

  describe(`${name}: binary and typed arrays`, () => {
    test('Uint8Array, Buffer, ArrayBuffer, DataView and other views are binary', () => {
      assert.equal(enc(new Uint8Array([1, 2, 3])), 'c403010203');
      assert.equal(enc(Buffer.from([1, 2, 3])), 'c403010203');
      assert.equal(enc(new Uint8Array([1, 2, 3]).buffer), 'c403010203');
      const base = new Uint8Array([9, 1, 2, 3, 9]);
      assert.equal(enc(base.subarray(1, 4)), 'c403010203', 'only the view, not the whole buffer');
      assert.equal(enc(new DataView(base.buffer, 1, 3)), 'c403010203');
      assert.equal(enc(new Uint8ClampedArray([1, 2])), 'c4020102');
      const i16 = new Int16Array([1, -2]);
      assert.equal(enc(i16), 'c404' + hex(new Uint8Array(i16.buffer)), 'raw bytes in platform order');
      assert.equal(enc(new BigInt64Array([1n])).slice(0, 4), 'c408');
    });
    test('binary decodes to a plain Uint8Array copy', () => {
      const input = unhex('c403010203');
      const out = decode(input);
      assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype);
      assert.deepEqual([...out], [1, 2, 3]);
      input[2] = 99;
      assert.equal(out[0], 1, 'not a view of the input');
      const fromBuffer = decode(Buffer.from('c403010203', 'hex'));
      assert.equal(Object.getPrototypeOf(fromBuffer), Uint8Array.prototype);
    });
    test('Float32Array / Float64Array ↔ vectors (little-endian, NaN bits kept)', () => {
      assert.equal(enc(new Float32Array([1, 2])), 'd7fb0000803f00000040');
      assert.equal(enc(new Float32Array([])), 'c700fb');
      assert.equal(enc(new Float64Array([1])), 'd7fa000000000000f03f');
      const f32 = new Float32Array([0, 1.5, -2]);
      new Uint32Array(f32.buffer)[0] = 0x7fc00001; // NaN with a payload
      const bytes = encode(f32);
      assert.equal(hex(bytes).slice(0, 14), 'c70cfb0100c07f', 'NaN payload untouched');
      const back = decode(bytes);
      assert.ok(back instanceof Float32Array);
      assert.equal(new Uint32Array(back.buffer)[0], 0x7fc00001);
      assert.deepEqual([...back.subarray(1)], [1.5, -2]);
      const f64 = new Float64Array([0.1, -1e300, 2.5, NaN, -0]);
      const r = decode(encode(f64));
      assert.ok(r instanceof Float64Array);
      assert.equal(r.length, 5);
      assert.ok(Object.is(r[4], -0) && Number.isNaN(r[3]) && r[0] === 0.1);
      assert.equal(enc(new Float32Array([1, 2, 3, 4]).subarray(1, 3)), 'd7fb' + '00000040' + '00004040');
    });
    test('vectors at unaligned offsets decode to aligned copies', () => {
      // [1, float64 vector] puts the payload at an odd offset.
      const bytes = encode([1, new Float64Array([1.25, -3])]);
      for (const shift of [0, 1, 3, 5]) {
        const buf = new Uint8Array(bytes.length + shift);
        buf.set(bytes, shift);
        const [one, vec] = decode(buf.subarray(shift));
        assert.equal(one, 1);
        assert.ok(vec instanceof Float64Array);
        assert.deepEqual([...vec], [1.25, -3]);
        assert.equal(vec.byteOffset, 0);
      }
      const [, f] = decode(encode(['x', new Float32Array([7.5])]));
      assert.deepEqual([...f], [7.5]);
    });
  });

  describe(`${name}: containers`, () => {
    test('Map with string keys encodes like a plain object; other keys are rejected', () => {
      const m = new Map([['b', 1], ['a', [true]]]);
      assert.equal(enc(m), enc({ a: [true], b: 1 }));
      assert.deepEqual(decode(encode(m)), { a: [true], b: 1 });
      throwsCode(() => encode(new Map([[1, 'x']])), 'invalid_argument');
      assert.equal(enc(new Map()), '80');
    });
    test('undefined encodes as nil (values, holes, top level)', () => {
      assert.equal(enc(undefined), 'c0');
      assert.equal(enc({ a: undefined }), '81a161c0');
      // eslint-disable-next-line no-sparse-arrays
      assert.equal(enc([1, , 3]), '9301c003');
      assert.equal(enc([undefined, null]), '92c0c0');
    });
    test('objects with a null prototype are maps', () => {
      const o = Object.create(null);
      o.k = 1;
      assert.equal(enc(o), '81a16b01');
    });
    test('keys are sorted by UTF-8 bytes, not UTF-16 code units', () => {
      const keys = ['\u{1F600}', '�', 'z', 'é', 'Z', '', '', '\u{10000}', 'zz'];
      const utf8Order = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const jsOrder = [...keys].sort();
      assert.notDeepEqual(jsOrder, utf8Order, 'the test needs keys where the two orders differ');
      const obj = Object.fromEntries(keys.map((k, i) => [k, i]));
      const decodedOrder = Object.keys(decode(encode(obj), { strict: true }));
      assert.deepEqual(decodedOrder, utf8Order);
      assert.equal(enc(obj), enc(new Map(keys.map((k, i) => [k, i]))));
      // The wire order is the UTF-8 order.
      const wire = [];
      const bytes = encode(obj);
      let p = 1;
      for (let i = 0; i < keys.length; i++) {
        const n = bytes[p] & 0x1f;
        wire.push(Buffer.from(bytes.subarray(p + 1, p + 1 + n)).toString('utf8'));
        p += 1 + n + 1;
      }
      assert.deepEqual(wire, utf8Order);
    });
    test('"__proto__" keys become own properties and never touch prototypes', () => {
      const v = dec('82a95f5f70726f746f5f5f81a8706f6c6c75746564c3a161 01'.replace(/ /g, ''));
      assert.equal(Object.getPrototypeOf(v), Object.prototype);
      assert.ok(Object.prototype.hasOwnProperty.call(v, '__proto__'));
      assert.deepEqual(Object.keys(v), ['__proto__', 'a']);
      assert.equal(v.polluted, undefined);
      assert.equal({}.polluted, undefined);
      assert.deepEqual(Object.getOwnPropertyDescriptor(v, '__proto__').value, { polluted: true });
      // Round trip of an object that has an own "__proto__" property.
      const own = JSON.parse('{"__proto__": {"x": 1}, "b": 2}');
      assert.deepEqual(decode(encode(own)), own);
      assert.equal(enc(own), hex(encode(decode(encode(own)))));
      for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        const o = decode(encode({ [key]: 1 }));
        assert.equal(o[key], 1);
        assert.ok(Object.prototype.hasOwnProperty.call(o, key));
      }
      // Tabular column named "__proto__".
      const rows = Array.from({ length: 10 }, (_, i) => JSON.parse(`{"__proto__": ${i}, "n": ${i}}`));
      const bytes = encode(rows);
      assert.equal(bytes[0], 0xc7, 'tabular');
      const back = decode(bytes);
      assert.equal(back.length, 10);
      for (const [i, r] of back.entries()) {
        assert.equal(Object.getPrototypeOf(r), Object.prototype);
        assert.equal(Object.getOwnPropertyDescriptor(r, '__proto__').value, i);
      }
      assert.equal({}.n, undefined);
    });
    test('duplicate keys: strict rejects, non-strict keeps the last', () => {
      throwsCode(() => dec('82a16101a16102'), 'duplicate_key');
      assert.deepEqual(dec('82a16101a16102', { strict: false }), { a: 2 });
      throwsCode(() => dec('82a95f5f70726f746f5f5f01a95f5f70726f746f5f5f02'), 'duplicate_key');
      const last = dec('82a95f5f70726f746f5f5f01a95f5f70726f746f5f5f02', { strict: false });
      assert.equal(Object.getOwnPropertyDescriptor(last, '__proto__').value, 2);
      assert.equal(Object.getPrototypeOf(last), Object.prototype);
      // "toString" exists on the prototype but is not a duplicate.
      assert.deepEqual(Object.keys(dec('82a8746f537472696e6701a16102')), ['toString', 'a']);
    });
    test('other objects encode like JSON.stringify sees them', () => {
      class Point {
        constructor(x, y) {
          this.x = x;
          this.y = y;
        }
        toJSON() {
          return { x: this.x, y: this.y, kind: 'point' };
        }
      }
      class Plain {
        constructor() {
          this.b = [1];
          this.a = 1;
          Object.defineProperty(this, 'hidden', { value: 2, enumerable: false });
          this[Symbol('s')] = 3;
        }
        get computed() {
          return 4; // a prototype getter: not an own property
        }
      }
      assert.equal(enc(new Point(1, 2)), enc({ x: 1, y: 2, kind: 'point' }));
      assert.equal(enc(new URL('https://btoon.net/a')), enc('https://btoon.net/a'));
      assert.equal(enc(new Plain()), enc({ a: 1, b: [1] }), 'own enumerable string keys only');
      // As in JSON.stringify, objects without own enumerable properties become empty maps.
      for (const v of [new Set([1]), new WeakMap(), /re/, new Error('x'), Promise.resolve(), Object(Symbol('s'))]) {
        assert.equal(enc(v), '80', Object.prototype.toString.call(v));
      }
      const err = new Error('x');
      err.code = 'E_X';
      assert.equal(enc(err), enc({ code: 'E_X' }));
      // Wrapper objects are unwrapped; a spoofed toStringTag is not.
      assert.equal(enc(Object(1)), '01');
      assert.equal(enc(new Number(1.5)), enc(1.5));
      assert.equal(enc(Object('str')), enc('str'));
      assert.equal(enc(Object(true)), 'c3');
      assert.equal(enc(Object(2n ** 70n)), enc(2n ** 70n));
      assert.equal(enc({ [Symbol.toStringTag]: 'Number', v: 1 }), enc({ v: 1 }));
      class Spoof {
        get [Symbol.toStringTag]() {
          return 'Number';
        }
      }
      assert.equal(enc(new Spoof()), '80');
      // Functions and symbols are rejected wherever they appear.
      for (const bad of [() => 1, function named() {}, class {}, Symbol('s')]) {
        throwsCode(() => encode(bad), 'invalid_argument');
        throwsCode(() => encode([bad]), 'invalid_argument');
        throwsCode(() => encode({ k: bad }), 'invalid_argument');
        throwsCode(() => encode(new Map([['k', bad]])), 'invalid_argument');
      }
      throwsCode(() => encode({ toJSON() {} }), 'invalid_argument'); // a plain object's function property
      // toJSON() is called once per value: a result with its own toJSON() is encoded by its
      // own properties, so toJSON() returning `this` terminates.
      class Nested {
        toJSON() {
          return new Point(1, 2);
        }
      }
      assert.equal(enc(new Nested()), enc({ x: 1, y: 2 }));
      class Self {
        constructor() {
          this.v = 7;
        }
        toJSON() {
          return this;
        }
      }
      assert.equal(enc(new Self()), enc({ v: 7 }));
      // Arrays of such objects qualify for tabular like the equivalent plain objects.
      const pts = Array.from({ length: 12 }, (_, i) => new Point(i, -i));
      assert.equal(enc(pts), enc(pts.map((p) => p.toJSON())));
      assert.equal(encode(pts)[0], 0xc7);
      const plains = Array.from({ length: 12 }, () => new Plain());
      assert.equal(enc(plains), enc(plains.map(() => ({ a: 1, b: [1] }))));
      assert.equal(encode(plains)[0], 0xc7);
      const selves = Array.from({ length: 12 }, () => new Self());
      assert.equal(enc(selves), enc(selves.map(() => ({ v: 7 }))));
      let calls = 0;
      class Counted {
        toJSON() {
          calls++;
          return 'c';
        }
      }
      encode([new Counted(), { a: new Counted() }, [new Counted(), new Counted()]]);
      assert.equal(calls, 4, 'toJSON() is called exactly once per value');
      calls = 0;
      encode(Array.from({ length: 10 }, () => ({ k: new Counted() })));
      assert.equal(calls, 10);
      calls = 0;
      encode(Array.from({ length: 10 }, () => new Counted()));
      assert.equal(calls, 10);
      // Cycles through class instances are still caught.
      const loop = new Plain();
      loop.b = loop;
      throwsCode(() => encode(loop), 'max_depth');
      // Exceptions from user code propagate unchanged.
      class Throws {
        toJSON() {
          throw new RangeError('mine');
        }
      }
      assert.throws(() => encode(new Throws()), (e) => e instanceof RangeError && e.message === 'mine');
    });
    test('cycles and nesting beyond maxDepth throw max_depth', () => {
      const a = { name: 'a' };
      a.self = a;
      throwsCode(() => encode(a), 'max_depth');
      const arr = [];
      arr.push(arr);
      throwsCode(() => encode(arr), 'max_depth');
      let deep = null;
      for (let i = 0; i < 128; i++) deep = [deep];
      assert.equal(encode(deep).length, 129);
      throwsCode(() => encode([deep]), 'max_depth');
      assert.equal(encode([deep], { maxDepth: 129 }).length, 130);
      throwsCode(() => encode([[1]], { maxDepth: 1 }), 'max_depth');
      assert.equal(enc(5, { maxDepth: 0 }), '05');
      throwsCode(() => encode([], { maxDepth: 0 }), 'max_depth');
      // A tabular array counts as two levels (array + row maps).
      const table = Array.from({ length: 10 }, (_, i) => ({ i }));
      assert.equal(encode(table, { maxDepth: 2 })[0], 0xc7);
      throwsCode(() => encode(table, { maxDepth: 1 }), 'max_depth');
      // maxDepth is at most 1000 (SPEC §7), and that much nesting fits the call stack.
      let huge = null;
      for (let i = 0; i < 200000; i++) huge = [huge];
      throwsCode(() => encode(huge, { maxDepth: 1000 }), 'max_depth');
      throwsCode(() => encode(huge, { maxDepth: 1001 }), 'invalid_argument');
      const deepBytes = new Uint8Array(200001).fill(0x91);
      deepBytes[200000] = 0xc0;
      throwsCode(() => decode(deepBytes, { maxDepth: 1000 }), 'max_depth');
      throwsCode(() => decode(deepBytes, { maxDepth: 1001 }), 'invalid_argument');
      let thousand = null;
      for (let i = 0; i < 1000; i++) thousand = [thousand];
      assert.equal(encode(thousand, { maxDepth: 1000 }).length, 1001);
      assert.equal(decode(deepBytes.subarray(199000), { maxDepth: 1000 }).length, 1);
      throwsCode(() => decode(deepBytes.subarray(198999), { maxDepth: 1000 }), 'max_depth');
    });
    test('values from another realm', () => {
      const ctx = vm.createContext({});
      const foreign = vm.runInContext(
        '({ obj: { b: 2, a: [1, 2] }, date: new Date(0), map: new Map([["k", 1]]), bytes: new Uint8Array([1, 2]), f32: new Float32Array([1]) })',
        ctx,
      );
      assert.equal(enc(foreign.obj), enc({ b: 2, a: [1, 2] }));
      assert.equal(enc(foreign.date), 'd6ff00000000');
      assert.equal(enc(foreign.map), enc({ k: 1 }));
      assert.equal(enc(foreign.bytes), 'c4020102');
      assert.equal(enc(foreign.f32), enc(new Float32Array([1])));
      assert.equal(enc(new Ext(1, foreign.bytes)), 'd5010102');
    });
  });

  describe(`${name}: timestamps`, () => {
    test('Date encodes with the MessagePack timestamp selection', () => {
      assert.equal(enc(new Date(0)), 'd6ff00000000');
      assert.equal(enc(new Date(Date.UTC(2024, 0, 1))), 'd6ff65920080');
      assert.equal(enc(new Date(Date.UTC(2024, 0, 1) + 500)), 'd7ff7735940065920080');
      assert.equal(enc(new Date(-1000)), 'c70cff00000000ffffffffffffffff');
      assert.equal(enc(new Date(-1)), 'c70cff3b8b87c0ffffffffffffffff', '-1 ms = second -1 + 999 ms');
      assert.equal(enc(new Date(8.64e15)), enc(new Timestamp(8640000000000n, 0)));
      throwsCode(() => encode(new Date(NaN)), 'invalid_argument');
    });
    test('timestamps decode to Date (ms, floor) or to Timestamp', () => {
      const ts = dec('c70cff075bcd15fffffff1886e0900'); // 0001-01-01T00:00:00.123456789Z
      assert.ok(ts instanceof Date);
      assert.equal(ts.toISOString(), '0001-01-01T00:00:00.123Z');
      const obj = dec('c70cff075bcd15fffffff1886e0900', { timestamps: 'object' });
      assert.ok(obj instanceof Timestamp);
      assert.equal(obj.seconds, -62135596800n);
      assert.equal(obj.nanoseconds, 123456789);
      assert.equal(obj.offsetMinutes, undefined);
      const withOffset = new Timestamp(1704067200n, 999, -330);
      const bytes = encode(withOffset);
      assert.equal(hex(bytes), 'c70eff000003e70000000065920080feb6');
      assert.deepEqual(decode(bytes, { timestamps: 'object' }), withOffset);
      assert.equal(decode(bytes).getTime(), 1704067200000, 'Date mode drops the offset');
      // Outside the range of Date: Timestamp even in Date mode.
      const far = new Timestamp(10n ** 15n, 5);
      const back = decode(encode(far));
      assert.ok(back instanceof Timestamp);
      assert.equal(back.seconds, 10n ** 15n);
    });
    test('date (-2) and datetime (-3) extensions', () => {
      assert.equal(dec('d7fe0000018bcfe5687b').getTime(), 1700000000123);
      assert.equal(dec('d7feffffffffffffffff').getTime(), -1);
      assert.equal(dec('d7fdffffffffffffffff').getTime(), -1, 'floor of -1 ns');
      const dt = dec('d7fd17979cfe3d85cd15', { timestamps: 'object' });
      assert.equal(dt.seconds, 1700000000n);
      assert.equal(dt.nanoseconds, 123456789);
      const d = dec('d7feffffffffffffffff', { timestamps: 'object' });
      assert.equal(d.seconds, -1n);
      assert.equal(d.nanoseconds, 999000000);
      assert.ok(dec('d7fe7fffffffffffffff') instanceof Timestamp, 'beyond Date range');
    });
    test('Timestamp validation and conversions', () => {
      throwsCode(() => new Timestamp(0n, 1e9), 'invalid_argument');
      throwsCode(() => new Timestamp(0n, -1), 'invalid_argument');
      throwsCode(() => new Timestamp(0n, 1.5), 'invalid_argument');
      throwsCode(() => new Timestamp(0n, 0, 1081), 'invalid_argument');
      throwsCode(() => new Timestamp(2n ** 63n, 0), 'invalid_argument');
      throwsCode(() => new Timestamp(1.5, 0), 'invalid_argument');
      throwsCode(() => new Timestamp('1', 0), 'invalid_argument');
      assert.equal(new Timestamp(5, 0).seconds, 5n);
      const d = new Date(Date.UTC(1969, 11, 31, 23, 59, 59, 250));
      const t = Timestamp.fromDate(d);
      assert.equal(t.seconds, -1n);
      assert.equal(t.nanoseconds, 250e6);
      assert.equal(t.toDate().getTime(), d.getTime());
      assert.equal(new Timestamp(0n, 999999).toDate().getTime(), 0);
      throwsCode(() => new Timestamp(10n ** 15n, 0).toDate(), 'invalid_argument');
      throwsCode(() => Timestamp.fromDate(new Date(NaN)), 'invalid_argument');
      // Fields changed after construction are re-validated by the encoder.
      const mutated = new Timestamp(0n, 0);
      mutated.nanoseconds = 2e9;
      throwsCode(() => encode(mutated), 'invalid_argument');
      assert.equal(enc(new Timestamp(0n, 0)), 'd6ff00000000');
      assert.equal(enc(new Timestamp(-1n, 0, 0)), 'c70eff00000000ffffffffffffffff0000', 'an explicit 0 offset is kept');
    });
  });

  describe(`${name}: Ext`, () => {
    test('generic extensions', () => {
      assert.equal(enc(new Ext(1, new Uint8Array([0xaa]))), 'd401aa');
      assert.equal(enc(new Ext(42, new Uint8Array([1, 2, 3]))), 'c7032a010203');
      assert.equal(enc(new Ext(-128, new Uint8Array(0))), 'c70080');
      const e = dec('d59c0102');
      assert.ok(e instanceof Ext);
      assert.equal(e.type, -100);
      assert.deepEqual([...e.data], [1, 2]);
      for (const t of [-7, -8, -9, -11, -128, 0, 127]) assert.equal(dec(enc(new Ext(t, new Uint8Array([1])))).type, t);
      throwsCode(() => new Ext(128, new Uint8Array(0)), 'invalid_argument');
      throwsCode(() => new Ext(1.5, new Uint8Array(0)), 'invalid_argument');
      throwsCode(() => new Ext(1, [1, 2]), 'invalid_argument');
      throwsCode(() => new Ext(1, new Uint16Array(1)), 'invalid_argument');
    });
    test('an Ext with an id BTOON defines is never written (SPEC §5.7)', () => {
      // Even valid, canonical payloads: those types are written from their typed values.
      const tabular = encode(Array.from({ length: 10 }, (_, i) => ({ ab: i })));
      const valid = {
        [-1]: unhex('65920080'), [-2]: unhex('0000018bcfe5687b'), [-3]: unhex('ffffffffffffffff'),
        [-4]: unhex('010000000000000000'), [-5]: unhex('0000803f'), [-6]: unhex('000000000000f03f'),
        [-10]: tabular.subarray(3),
      };
      for (const [type, data] of Object.entries(valid).map(([t, d]) => [Number(t), d])) {
        const e = new Ext(type, data); // the constructor accepts it; the encoder refuses it
        throwsCode(() => encode(e), 'invalid_argument');
        throwsCode(() => encode([1, { k: e }]), 'invalid_argument');
        throwsCode(() => encode(Array.from({ length: 10 }, () => ({ k: e }))), 'invalid_argument');
        throwsCode(() => encode(new Ext(type, new Uint8Array(3))), 'invalid_argument');
        assert.throws(() => encode(e), (err) => err.code === 'invalid_argument' && err.message.includes(`Ext type ${type} `));
      }
      // The typed values write these types.
      assert.equal(enc(new Date(Date.UTC(2024, 0, 1))), 'd6ff65920080');
      assert.equal(enc(2n ** 64n), 'c709fc010000000000000000');
      assert.equal(enc(new Float32Array([1])), 'd6fb0000803f');
      // Ids reserved for future versions are written as given, like application ids.
      for (const type of [-7, -8, -9, -11, -12, -100, -127, -128]) {
        const back = dec(enc(new Ext(type, Uint8Array.of(1, 2))));
        assert.ok(back instanceof Ext);
        assert.equal(back.type, type);
        assert.deepEqual([...back.data], [1, 2]);
      }
      assert.equal(enc(new Ext(-11, Uint8Array.of(1))), 'd4f501');
      // Fields reassigned after construction are checked again.
      const changed = new Ext(5, Uint8Array.of(1));
      Object.defineProperty(changed, 'type', { value: -4 });
      throwsCode(() => encode(changed), 'invalid_argument');
      const data16 = new Ext(5, Uint8Array.of(1, 2));
      Object.defineProperty(data16, 'data', { value: new Uint16Array([0x0102]) });
      throwsCode(() => encode(data16), 'invalid_argument');
    });
  });

  describe(`${name}: decoding inputs and options`, () => {
    test('accepts Uint8Array, Buffer, ArrayBuffer, DataView and views at an offset', () => {
      const bytes = encode({ a: [1, 'x'] });
      const padded = new Uint8Array(bytes.length + 4);
      padded.set(bytes, 2);
      for (const input of [
        bytes,
        Buffer.from(bytes),
        bytes.buffer,
        new DataView(padded.buffer, 2, bytes.length),
        padded.subarray(2, 2 + bytes.length),
      ]) {
        assert.deepEqual(decode(input), { a: [1, 'x'] });
      }
      for (const bad of ['c0', 5, null, undefined, [0xc0], {}]) throwsCode(() => decode(bad), 'invalid_argument');
    });
    test('option validation', () => {
      throwsCode(() => encode(1, { maxDepth: -1 }), 'invalid_argument');
      throwsCode(() => encode(1, { maxDepth: 1.5 }), 'invalid_argument');
      throwsCode(() => encode(1, { maxDepth: 1001 }), 'invalid_argument');
      throwsCode(() => dec('c0', { maxDepth: 1001 }), 'invalid_argument');
      throwsCode(() => dec('c0', { maxDepth: Infinity }), 'invalid_argument');
      throwsCode(() => encode(1, { hmacKey: null }), 'invalid_argument');
      throwsCode(() => dec('c0', { hmacKey: null }), 'invalid_argument');
      for (const bad of [-1, 1.5, '10', Infinity, NaN, null, 2 ** 53]) {
        throwsCode(() => dec('c0', { maxValues: bad }), 'invalid_argument');
      }
      assert.equal(dec('c0', { maxValues: Number.MAX_SAFE_INTEGER }), null);
      throwsCode(() => encode(1, { compression: 'gzip' }), 'invalid_argument');
      throwsCode(() => encode(1, { autoTabular: 'yes' }), 'invalid_argument');
      throwsCode(() => encode(1, { hmacKey: '' }), 'invalid_argument');
      throwsCode(() => encode(1, { hmacKey: new Uint8Array(0) }), 'invalid_argument');
      throwsCode(() => encode(1, { hmacKey: 42 }), 'invalid_argument');
      throwsCode(() => encode(1, { hmacKey: '\uD800' }), 'invalid_argument');
      throwsCode(() => encode(1, { codecs: 5 }), 'invalid_argument');
      throwsCode(() => encode(1, { codecs: { zlib: { compress: 1 } } }), 'invalid_argument');
      throwsCode(() => encode(1, 'opts'), 'invalid_argument');
      throwsCode(() => dec('c0', { timestamps: 'iso' }), 'invalid_argument');
      throwsCode(() => dec('c0', { bigint: 'never' }), 'invalid_argument');
      throwsCode(() => dec('c0', { strict: 1 }), 'invalid_argument');
      throwsCode(() => dec('c0', { maxDecompressedSize: -5 }), 'invalid_argument');
      assert.equal(dec('c0', null), null);
      assert.equal(enc(1, null), '01');
    });
    test('non-strict mode relaxes trailing data, duplicates and the UTF-8 of string values only', () => {
      assert.equal(dec('0102', { strict: false }), 1);
      throwsCode(() => dec('0102'), 'trailing_data');
      assert.equal(dec('a1ff', { strict: false }), '\uFFFD');
      assert.deepEqual(dec('81a16192a1ffa3e08080', { strict: false }), { a: ['\uFFFD', '\uFFFD\uFFFD\uFFFD'] });
      throwsCode(() => dec('a1ff'), 'invalid_utf8');
      // Map keys and column names must be valid UTF-8 in both modes (SPEC §7).
      throwsCode(() => dec('81a1ff01', { strict: false }), 'invalid_utf8');
      throwsCode(() => dec('82a1ff01a1fe02', { strict: false }), 'invalid_utf8');
      throwsCode(() => dec('81d920' + 'ff'.repeat(32) + '01', { strict: false }), 'invalid_utf8');
      throwsCode(() => dec('c717f600000001000000010000000100000001ff0000000001c0', { strict: false }), 'invalid_utf8');
      throwsCode(() => dec('9201', { strict: false }), 'truncated');
      throwsCode(() => dec('9191c0', { strict: false, maxDepth: 1 }), 'max_depth');
      throwsCode(() => dec('ddffffffff', { strict: false }), 'truncated');
      throwsCode(() => dec('c1', { strict: false }), 'invalid_marker');
    });
  });
}

test('CommonJS builds expose the same API', () => {
  for (const name of ['cjs/node', 'cjs/portable']) {
    const lib = builds[name];
    const esm = builds[name.replace('cjs', 'esm')];
    assert.deepEqual(Object.keys(lib).sort(), Object.keys(esm).sort());
    assert.equal(hex(lib.encode({ a: [1, 2n ** 70n, new Date(0)] })), hex(esm.encode({ a: [1, 2n ** 70n, new Date(0)] })));
  }
  assert.deepEqual(Object.keys(builds['esm/node']).sort(), [
    'BtoonError', 'Ext', 'SPEC_VERSION', 'Timestamp', 'VERSION', 'decode', 'decodeAsync', 'encode', 'encodeAsync',
  ]);
});

test('Ext and Timestamp from another copy of the library encode correctly', () => {
  const esm = builds['esm/node'];
  const cjs = builds['cjs/portable'];
  assert.equal(hex(esm.encode(new cjs.Ext(5, new Uint8Array([1])))), 'd40501');
  assert.equal(hex(cjs.encode(new esm.Timestamp(0n, 0, 60))), 'c70eff' + '0'.repeat(24) + '003c');
});
