'use strict';
// API parity cases shared by @btoon/js (btoon-javascript, the reference) and the native
// `btoon` package (btoon-nodejs). Both repositories hold this file, and the copies must stay
// identical: each runs every case against its own package and expects the same outcome, so
// the two packages behave alike by construction. btoon-nodejs also runs the cases against
// both packages side by side when @btoon/js is available.
//
// A case is [name, fn(lib), expected]. `expected` is ok(x) when fn returns x (compared through
// show()), err(code, pattern?) when fn throws a BtoonError with that code (and a message
// matching the pattern), or raw(name) when it throws another error of that name.

const vm = require('node:vm');

const ok = (value) => ({ ok: value });
const err = (code, message) => (message === undefined ? { error: code } : { error: code, message });
const raw = (name) => ({ throws: name });

const brand = (v, name) => typeof v === 'object' && v !== null && v[Symbol.for(`btoon.${name}`)] === true;
const hex = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');

/**
 * A plain-JSON description of a value, so that the packages' results compare exactly: the
 * numbers -0 and NaN, bigints, binaries (a Buffer and a Uint8Array alike), vectors, Dates and
 * this library's classes by brand and fields. Object keys are sorted (the native package
 * builds decoded maps in key order, @btoon/js in input order).
 */
function show(v) {
  switch (typeof v) {
    case 'number':
      return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : v;
    case 'bigint':
      return `${v}n`;
    case 'undefined':
      return '<undefined>';
    case 'function':
    case 'symbol':
      return `<${typeof v}>`;
    case 'object':
      break;
    default:
      return v;
  }
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(show);
  if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') {
    const t = Date.prototype.getTime.call(v);
    return `Date(${Number.isNaN(t) ? 'invalid' : t})`;
  }
  if (brand(v, 'Timestamp')) {
    const fields = `${v.seconds}, ${v.nanoseconds}, ${v.offsetMinutes}`;
    if (brand(v, 'DateTime')) return `BtoonDateTime(${v.epochNanoseconds}; ${fields})`;
    if (brand(v, 'Date')) return `BtoonDate(${v.epochMilliseconds}; ${fields})`;
    return `Timestamp(${fields})`;
  }
  if (brand(v, 'Ext')) return `Ext(${v.type}, ${ArrayBuffer.isView(v.data) ? hex(v.data) : show(v.data)})`;
  if (ArrayBuffer.isView(v)) {
    const tag = v[Symbol.toStringTag];
    if (tag === 'Float32Array' || tag === 'Float64Array') return `${tag}(${hex(v)})`;
    if (tag === 'Uint8Array') return `bytes(${hex(v)})`;
    return `${tag ?? 'DataView'}(${hex(v)})`;
  }
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = show(v[k]);
  if (Object.getPrototypeOf(v) !== Object.prototype) return { '<proto>': Object.getPrototypeOf(v)?.constructor?.name ?? null, ...out };
  return out;
}

/** Runs `fn` and describes what happened, in the form of ok()/err()/raw(). */
function outcome(fn) {
  let value;
  try {
    value = fn();
  } catch (e) {
    if (brand(e, 'BtoonError')) return { error: e.code, messageText: e.message };
    return { throws: e?.name ?? typeof e };
  }
  return { ok: show(value) };
}

/** True if `got` (from outcome()) is what `expected` describes; otherwise a description of the difference. */
function matches(got, expected) {
  if ('ok' in expected) return 'ok' in got && JSON.stringify(got.ok) === JSON.stringify(expected.ok);
  if ('error' in expected) {
    if (got.error !== expected.error) return false;
    return expected.message === undefined || expected.message.test(got.messageText);
  }
  return got.throws === expected.throws;
}

function cases(lib) {
  const { encode, decode, Ext, Timestamp, BtoonDate, BtoonDateTime, BtoonError } = lib;
  const enc = (v, o) => hex(encode(v, o));
  const dec = (h, o) => decode(Buffer.from(h, 'hex'), o);
  const rt = (v, eo, dopt) => decode(encode(v, eo), dopt);
  const i64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(n));
    return b.toString('hex');
  };
  const reactive = (target) =>
    new Proxy(target, {
      get(t, key) {
        const v = Reflect.get(t, key, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const sab = (bytes) => {
    const s = new SharedArrayBuffer(bytes.length);
    new Uint8Array(s).set(bytes);
    return s;
  };
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const mutate = (v, f) => {
    f(v);
    return v;
  };

  return [
    // --- values JSON.stringify unwraps or calls ------------------------------------------
    ['boxed Number', () => enc(new Number(5)), ok('05')],
    ['boxed -0', () => enc(new Number(-0)), ok('cb8000000000000000')],
    ['boxed String', () => enc(new String('ab')), ok('a26162')],
    ['boxed Boolean', () => enc(new Boolean(false)), ok('c2')],
    ['boxed BigInt', () => enc(Object(2n ** 70n)), ok('c709fc400000000000000000')],
    ['boxed Symbol is an object', () => enc(Object(Symbol('s'))), ok('80')],
    ['spoofed toStringTag is not boxed', () => enc({ [Symbol.toStringTag]: 'Number', v: 1 }), ok('81a17601')],
    ['plain object with own toJSON', () => enc({ toJSON: () => 'X' }), ok('a158')],
    ['nested plain toJSON', () => enc({ a: { toJSON: () => [1, 2] } }), ok('81a161920102')],
    ['null-prototype toJSON', () => enc(Object.assign(Object.create(null), { toJSON: () => 7 })), ok('07')],
    ['toJSON returning undefined', () => enc({ toJSON() {} }), ok('c0')],
    ['toJSON that is not a function', () => enc({ toJSON: 5 }), ok('81a6746f4a534f4e05')],
    ['toJSON chain stops after one call', () => enc({ v: { toJSON: () => ({ toJSON: () => 42 }) } }), err('invalid_argument', /cannot encode a function/)],
    ['class toJSON returning a class with toJSON', () => {
      class Inner { constructor() { this.x = 1; } toJSON() { return 'inner'; } }
      class Outer { toJSON() { return new Inner(); } }
      return enc(new Outer());
    }, ok('81a17801')],
    ['toJSON is called once per value', () => {
      let calls = 0;
      const v = { toJSON: () => (calls++, { a: 1 }) };
      encode([v, v, { k: v }, rows(4, () => v), new Map([['m', v]])]);
      return calls;
    }, ok(8)],
    ['toJSON adds no nesting level', () => {
      let v = { toJSON: () => 'leaf' };
      for (let i = 0; i < 128; i++) v = [v];
      return encode(v).length;
    }, ok(133)],
    ['a class toJSON at the depth limit', () => {
      class Money { constructor(v) { this.v = v; } toJSON() { return String(this.v); } }
      let v = new Money(5);
      for (let i = 0; i < 128; i++) v = [v];
      return encode(v).length;
    }, ok(130)],
    ['toJSON exception propagates', () => encode({ toJSON() { throw new RangeError('mine'); } }), raw('RangeError')],
    ['polluted Object.prototype.toJSON is ignored for plain objects', () => {
      Object.prototype.toJSON = () => 'polluted';
      try {
        return enc({ a: 1 });
      } finally {
        delete Object.prototype.toJSON;
      }
    }, ok('81a16101')],

    // --- objects, getters, proxies ------------------------------------------------------
    ['class instance: own enumerable properties', () => {
      class P { constructor() { this.b = 2; this.a = 1; Object.defineProperty(this, 'h', { value: 3 }); } get g() { return 4; } }
      return enc(new P());
    }, ok('82a16101a16202')],
    ['symbol keys and non-enumerables are skipped', () => enc(Object.defineProperty({ [Symbol('s')]: 1, a: 2 }, 'b', { value: 3 })), ok('81a16102')],
    ['sparse array holes are nil', () => enc([1, , 3]), ok('9301c003')],
    ['array extra properties are ignored', () => enc(Object.assign([1], { x: 2 })), ok('9101')],
    ['Set, WeakMap, RegExp and Error are empty maps', () => [new Set([1]), new WeakMap(), /x/, new Error('e')].map((v) => enc(v)), ok(['80', '80', '80', '80'])],
    ['getter reads in sorted key order, lazily', () => {
      const order = [];
      const o = {};
      for (const k of ['b', 'c', 'a']) Object.defineProperty(o, k, { enumerable: true, get: () => (order.push(k), k) });
      encode(o);
      return order.join('');
    }, ok('abc')],
    ['a getter changing a later property', () => {
      const o = { get a() { o.b = 'changed'; return 1; }, b: 'orig' };
      return rt(o);
    }, ok({ a: 1, b: 'changed' })],
    ['a getter emptying the rows of a table', () => {
      const r = [];
      for (let i = 0; i < 10; i++) r.push({ a: i, get b() { r.length = 0; return i; } });
      return rt(r);
    }, ok(rows(10, (i) => ({ a: i, b: i })))],
    ['a getter replacing a Map row', () => {
      const r = rows(10, (i) => new Map([['a', i], ['b', i]]));
      r[0] = { a: 0, get b() { r[5] = { a: 'x', b: 'y' }; return 0; } };
      return rt(r)[5];
    }, ok({ a: 5, b: 5 })],
    ['a getter nulling a later row', () => {
      const r = rows(10, (i) => ({ a: i, b: i }));
      Object.defineProperty(r[0], 'b', { enumerable: true, get() { r[3] = null; return 0; } });
      return rt(r)[3];
    }, ok({ a: 3, b: 3 })],
    ['a getter that throws', () => encode({ get a() { throw new TypeError('boom'); } }), raw('TypeError')],
    ['Proxy of an array', () => enc(new Proxy([10, 20, 30], {})), ok('930a141e')],
    ['Proxy of an object', () => enc(new Proxy({ b: 1, a: 2 }, {})), ok('82a16102a16201')],
    ['Proxy of a class with toJSON', () => {
      class S { constructor() { this.secret = 's'; } toJSON() { return 'public'; } }
      return enc(new Proxy(new S(), {}));
    }, ok('a67075626c6963')],
    ['Proxy of a table', () => enc(new Proxy(rows(10, (i) => ({ a: i })), {})), ok('c720f600000001000000010000000a0000000161020000000a00010203040506070809')],
    ['Proxy of an array with a bad length', () => enc(new Proxy([1, 2], { get: (t, k) => (k === 'length' ? 1.5 : Reflect.get(t, k)) })), err('invalid_argument')],
    ['Proxy of a Date', () => enc(new Proxy(new Date(0), {})), err('invalid_argument', /expected a Date/)],
    ['revoked Proxy', () => {
      const { proxy, revoke } = Proxy.revocable([1], {});
      revoke();
      return enc(proxy);
    }, raw('TypeError')],

    // --- Maps ---------------------------------------------------------------------------
    ['Map with string keys', () => enc(new Map([['b', 1], ['a', 2]])), ok('82a16102a16201')],
    ['Map with a non-string key', () => enc(new Map([[1, 'x']])), err('invalid_argument', /Map keys must be strings/)],
    ['Map subclass whose iterator repeats a key', () => {
      class M extends Map { *[Symbol.iterator]() { yield ['a', 1]; yield ['a', 2]; } *entries() { yield ['a', 1]; yield ['a', 2]; } *keys() { yield 'a'; yield 'a'; } }
      return enc(new M([['a', 0]]));
    }, ok('81a16100')],
    ['rows of a Map subclass whose iterator repeats a key', () => {
      class M extends Map { *[Symbol.iterator]() { yield ['a', 1]; yield ['a', 2]; } }
      return enc([new M([['a', 0]]), new M([['a', 0]])]);
    }, ok('9281a1610081a16100')],
    ['reactive (proxied) Map', () => enc(reactive(new Map([['b', 1], ['a', [2]]]))), ok('82a1619102a16201')],
    ['reactive Maps as table rows', () => enc(rows(8, (i) => reactive(new Map([['id', i]])))), ok('c71ff600000001000000010000000800000002696402000000080001020304050607')],
    ['a proxied Map whose keys() repeats a key', () => enc(new Proxy(new Map([['a', 1]]), {
      get(t, k) {
        if (k === 'keys') return () => ['a', 'a'][Symbol.iterator]();
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    })), err('invalid_argument')],
    ['bare Proxy of a Map', () => enc(new Proxy(new Map([['a', 1]]), {})), raw('TypeError')],
    ['Object.create(Map.prototype)', () => enc(Object.create(Map.prototype)), raw('TypeError')],

    // --- other realms and shared memory -------------------------------------------------
    ['another realm: Map, Date, object, Uint8Array', () => {
      const f = vm.runInNewContext('({ m: new Map([["a", 1]]), d: new Date(0), o: { a: 1 }, u: new Uint8Array([7]) })');
      return [enc(f.m), enc(f.d), enc(f.o), enc(f.u)];
    }, ok(['81a16101', 'd6ff00000000', '81a16101', 'c40107'])],
    ['SharedArrayBuffer encodes as binary', () => enc(sab([1, 2, 3])), ok('c403010203')],
    ['Uint8Array over a SharedArrayBuffer', () => enc(new Uint8Array(sab([1, 2, 3]))), ok('c403010203')],
    ['decode a SharedArrayBuffer', () => decode(sab([0x05])), ok(5)],
    ['decode a view of a SharedArrayBuffer', () => decode(new Uint8Array(sab(Buffer.from('81a161c3', 'hex')))), ok({ a: true })],
    ['decode a signed document in shared memory', () => {
      const key = 'k'.repeat(32);
      return decode(new Uint8Array(sab(encode({ a: 1 }, { hmacKey: key }))), { hmacKey: key });
    }, ok({ a: 1 })],

    // --- numbers, strings, binaries -----------------------------------------------------
    ['-0, NaN, 2^53, 1.5', () => [-0, NaN, 2 ** 53, 1.5].map((v) => enc(v)), ok(['cb8000000000000000', 'cb7ff8000000000000', 'cb4340000000000000', 'cb3ff8000000000000'])],
    ['bigints', () => [5n, -(2n ** 63n), 2n ** 64n - 1n, 2n ** 64n, -(2n ** 63n) - 1n].map((v) => enc(v)), ok(['05', 'd38000000000000000', 'cfffffffffffffffff', 'c709fc010000000000000000', 'c709fcff7fffffffffffffff'])],
    ['functions', () => enc({ f() {} }), err('invalid_argument', /cannot encode a function/)],
    ['symbols', () => enc([Symbol('s')]), err('invalid_argument', /cannot encode a symbol/)],
    ['lone surrogate', () => enc('a\ud800'), err('invalid_utf8')],
    ['lone surrogate in a key', () => enc({ ['k\udfff']: 1 }), err('invalid_utf8')],
    ['typed arrays as bytes', () => [new Int16Array([1, -1]), new BigInt64Array([-1n]), new Uint8ClampedArray([1, 255]), new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)].map((v) => enc(v)), ok(['c4040100ffff', 'c408ffffffffffffffff', 'c40201ff', 'c4020807'])],
    ['float vectors', () => [enc(new Float32Array([1.5, -2])), enc(new Float64Array([0.25]))], ok(['d7fb0000c03f000000c0', 'd7fa000000000000d03f'])],
    ['binary decodes to bytes', () => dec('c403010203'), ok('bytes(010203)')],

    // --- dates, timestamps, typed dates -------------------------------------------------
    ['Date at the end of its range', () => enc(new Date(8.64e15)), ok('c70cff00000000000007dba8218000')],
    ['invalid Date', () => enc(new Date(NaN)), err('invalid_argument', /cannot encode an invalid Date/)],
    ['new Timestamp(5n): nanoseconds default to 0', () => new Timestamp(5n), ok('Timestamp(5, 0, undefined)')],
    ['Timestamp seconds beyond int64', () => new Timestamp(2n ** 63n), err('invalid_argument', /signed 64-bit/)],
    ['Timestamp seconds as an unsafe number', () => new Timestamp(2 ** 60, 0), err('invalid_argument', /bigint or a safe integer/)],
    ['Timestamp seconds as a string', () => new Timestamp('12', 0), err('invalid_argument', /bigint or a safe integer/)],
    ['Timestamp nanoseconds out of range', () => new Timestamp(0, 1e9), err('invalid_argument', /nanoseconds/)],
    ['Timestamp nanoseconds null', () => new Timestamp(0, null), err('invalid_argument', /nanoseconds/)],
    ['Timestamp offset out of range', () => new Timestamp(0, 0, 1081), err('invalid_argument', /offsetMinutes/)],
    ['Timestamp offset null', () => new Timestamp(0, 0, null), err('invalid_argument', /offsetMinutes/)],
    ['Timestamp seconds changed to a number', () => enc(mutate(new Timestamp(0), (t) => { t.seconds = 5; })), err('invalid_argument', /seconds/)],
    ['Timestamp offset changed to null', () => enc(mutate(new Timestamp(0, 0, 60), (t) => { t.offsetMinutes = null; })), err('invalid_argument', /offsetMinutes/)],
    ['Timestamp offset changed to undefined', () => enc(mutate(new Timestamp(0, 0, 60), (t) => { t.offsetMinutes = undefined; })), ok('d6ff00000000')],
    ['Timestamp.toDate out of range', () => new Timestamp(10n ** 13n).toDate(), err('invalid_argument', /range of Date/)],
    ['Timestamp.fromDate', () => Timestamp.fromDate(new Date(-1)), ok('Timestamp(-1, 999000000, undefined)')],
    ['Timestamp.fromDate(invalid)', () => Timestamp.fromDate(new Date(NaN)), err('invalid_argument', /cannot convert an invalid Date/)],
    ['Timestamp.fromDate(not a Date)', () => Timestamp.fromDate({}), err('invalid_argument', /expected a Date/)],
    ['BtoonDate', () => new BtoonDate(-1n), ok('BtoonDate(-1; -1, 999000000, undefined)')],
    ['BtoonDate from a number', () => new BtoonDate(1700000000123), ok('BtoonDate(1700000000123; 1700000000, 123000000, undefined)')],
    ['BtoonDate out of range', () => new BtoonDate(2n ** 63n), err('invalid_argument', /BtoonDate epochMilliseconds/)],
    ['BtoonDate from a string', () => new BtoonDate('5'), err('invalid_argument', /BtoonDate epochMilliseconds/)],
    ['BtoonDateTime', () => new BtoonDateTime(-1n), ok('BtoonDateTime(-1; -1, 999999999, undefined)')],
    ['BtoonDateTime from an unsafe number', () => new BtoonDateTime(2 ** 53), err('invalid_argument', /BtoonDateTime epochNanoseconds/)],
    ['BtoonDate.fromDate', () => BtoonDate.fromDate(new Date(42)), ok('BtoonDate(42; 0, 42000000, undefined)')],
    ['BtoonDateTime.fromDate beyond its range', () => BtoonDateTime.fromDate(new Date(8.64e15)), err('invalid_argument', /range of BtoonDateTime/)],
    ['BtoonDate.fromTimestamp floors', () => BtoonDate.fromTimestamp(new Timestamp(-1n, 999999999)), ok('BtoonDate(-1; -1, 999000000, undefined)')],
    ['BtoonDateTime.fromTimestamp is exact', () => BtoonDateTime.fromTimestamp(new Timestamp(1n, 5)), ok('BtoonDateTime(1000000005; 1, 5, undefined)')],
    ['fromTimestamp refuses an offset', () => BtoonDate.fromTimestamp(new Timestamp(0, 0, 0)), err('invalid_argument', /offset/)],
    ['fromTimestamp refuses a non-Timestamp', () => BtoonDateTime.fromTimestamp(new Date(0)), err('invalid_argument', /expects a Timestamp/)],
    ['fromTimestamp out of range', () => BtoonDateTime.fromTimestamp(new Timestamp(10n ** 10n)), err('invalid_argument', /range of BtoonDateTime/)],
    ['encode BtoonDate and BtoonDateTime', () => [enc(new BtoonDate(1700000000123n)), enc(new BtoonDateTime(-1n))], ok(['d7fe0000018bcfe5687b', 'd7fdffffffffffffffff'])],
    ['BtoonDate epoch changed to a number', () => enc(mutate(new BtoonDate(0n), (d) => { d.epochMilliseconds = 5; })), err('invalid_argument', /BtoonDate epochMilliseconds/)],
    ['typed dates as table cells', () => enc(rows(6, (i) => ({ at: new BtoonDateTime(1700000000123456789n + BigInt(i)), day: new BtoonDate(1700000000000n + BigInt(i) * 86400000n), id: i }))),
      ok('c7acf6000000010000000300000006000000026174000000036461790000000269640909020000003cd7fd17979cfe3d85cd15d7fd17979cfe3d85cd16d7fd17979cfe3d85cd17d7fd17979cfe3d85cd18d7fd17979cfe3d85cd19d7fd17979cfe3d85cd1a0000003cd7fe0000018bcfe56800d7fe0000018bd50bc400d7fe0000018bda322000d7fe0000018bdf587c00d7fe0000018be47ed800d7fe0000018be9a5340000000006000102030405')],
    ["decode with timestamps: 'object'", () => [dec('d6ff00000001', { timestamps: 'object' }), dec('d7fe0000018bcfe5687b', { timestamps: 'object' }), dec('d7fd17979cfe3d85cd15', { timestamps: 'object' })],
      ok(['Timestamp(1, 0, undefined)', 'BtoonDate(1700000000123; 1700000000, 123000000, undefined)', 'BtoonDateTime(1700000000123456789; 1700000000, 123456789, undefined)'])],
    ["decode with timestamps: 'date'", () => [dec('d6ff00000001'), dec('d7fe0000018bcfe5687b'), dec('d7fd17979cfe3d85cd15'), dec('c70cff00000000' + i64(10n ** 13n)), dec('d7fe' + i64(2n ** 63n - 1n))],
      ok(['Date(1000)', 'Date(1700000000123)', 'Date(1700000000123)', 'Timestamp(10000000000000, 0, undefined)', 'BtoonDate(9223372036854775807; 9223372036854775, 807000000, undefined)'])],
    ['a decoded date encodes back to a date', () => enc(dec('d7fe7fffffffffffffff')), ok('d7fe7fffffffffffffff')],

    // --- Ext --------------------------------------------------------------------------------
    ['Ext with an application id', () => enc(new Ext(5, new Uint8Array(0))), ok('c70005')],
    ['Ext with a reserved id', () => enc(new Ext(-7, Uint8Array.of(1))), ok('d4f901')],
    ['Ext type out of range', () => new Ext(200, new Uint8Array(0)), err('invalid_argument', /Ext type must be an integer in \[-128, 127\], got 200/)],
    ['Ext data as an array', () => new Ext(1, [1, 2]), err('invalid_argument', /Ext data must be a Uint8Array/)],
    ['Ext data as a Uint16Array', () => new Ext(1, new Uint16Array([0x1234])), err('invalid_argument', /Ext data must be a Uint8Array/)],
    ['Ext data as a Buffer', () => enc(new Ext(1, Buffer.from([1, 2]))), ok('d5010102')],
    ['Ext data replaced', () => enc(mutate(new Ext(1, new Uint8Array(1)), (e) => { e.data = new Float32Array([1.5]); })), err('invalid_argument', /Ext data must be a Uint8Array/)],
    ['Ext type replaced', () => enc(mutate(new Ext(1, new Uint8Array(1)), (e) => { e.type = 300; })), err('invalid_argument', /Ext type must be an integer/)],
    ['raw Ext(-1)', () => enc(new Ext(-1, new Uint8Array(4))), err('invalid_argument', /Ext type -1 is defined by BTOON.*Date or Timestamp/)],
    ['raw Ext(-2)', () => enc(new Ext(-2, new Uint8Array(8))), err('invalid_argument', /Ext type -2 is defined by BTOON.*BtoonDate/)],
    ['raw Ext(-3)', () => enc(new Ext(-3, new Uint8Array(8))), err('invalid_argument', /Ext type -3 is defined by BTOON.*BtoonDateTime/)],
    ['raw Ext(-10)', () => enc(new Ext(-10, new Uint8Array(12))), err('invalid_argument', /Ext type -10 is defined by BTOON/)],
    ['decode an Ext', () => dec('d40501'), ok('Ext(5, 01)')],

    // --- tables -------------------------------------------------------------------------
    ['class instances and Maps make the same table', () => {
      class R { constructor(i) { this.id = i; this.name = `n${i}`; } }
      const a = enc(rows(10, (i) => new R(i)));
      return [a === enc(rows(10, (i) => ({ id: i, name: `n${i}` }))), a === enc(rows(10, (i) => new Map([['id', i], ['name', `n${i}`]])))];
    }, ok([true, true])],
    ['toJSON rows make a table', () => enc(rows(10, (i) => ({ toJSON: () => ({ i }) }))), ok('c720f600000001000000010000000a0000000169020000000a00010203040506070809')],
    ['a table counts two nesting levels', () => [encode(rows(10, (i) => ({ i })), { maxDepth: 2 })[0], outcome(() => enc(rows(10, (i) => ({ i })), { maxDepth: 1 })).error], ok([0xc7, 'max_depth'])],
    ['cycles', () => {
      const o = {};
      o.self = o;
      return enc(o);
    }, err('max_depth', /maximum nesting depth exceeded \(or the value is cyclic\)/)],

    // --- integers on decode ---------------------------------------------------------------
    ["bigint: 'auto'", () => ['cf001fffffffffffff', 'cf0020000000000000', 'c701fc05'].map((h) => dec(h)), ok([9007199254740991, '9007199254740992n', 5])],
    ["bigint: 'always'", () => ['05', 'cd012c', 'ceffffffff', 'cf0000000100000000', 'cf0000000000000005', 'd3ffffffff7fffffff', 'c701fc05', 'c705fc0100000000'].map((h) => dec(h, { bigint: 'always' })),
      ok([5, 300, 4294967295, '4294967296n', 5, '-2147483649n', 5, '4294967296n'])],

    // --- decode input and results -----------------------------------------------------------
    ['decode an ArrayBuffer and a DataView', () => [decode(new Uint8Array([0x05]).buffer), decode(new DataView(new Uint8Array([9, 0x05]).buffer, 1))], ok([5, 5])],
    ['decode a string', () => decode('05'), err('invalid_argument', /expects a Uint8Array, ArrayBuffer or other ArrayBufferView/)],
    ['decode null', () => decode(null), err('invalid_argument', /expects a Uint8Array/)],
    ['decode an array of numbers', () => decode([5]), err('invalid_argument')],
    ['decode an object claiming to be an ArrayBuffer', () => decode({ [Symbol.toStringTag]: 'ArrayBuffer', length: 1, 0: 5 }), err('invalid_argument')],
    ['decode a detached buffer', () => {
      const buffer = new ArrayBuffer(1);
      const view = new Uint8Array(buffer);
      structuredClone(buffer, { transfer: [buffer] });
      return [outcome(() => decode(view)).error, outcome(() => decode(buffer)).error];
    }, ok(['truncated', 'truncated'])],
    ['a typed array claiming another type', () => {
      class Fake extends Uint8Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
      return enc(new Fake(3));
    }, ok('c403000000')],
    ['a typed array misreporting its size', () => {
      class Liar extends Uint8Array { get byteLength() { return 1; } get length() { return 1; } get byteOffset() { return 1; } }
      const ext = new Ext(9, new Liar([1, 2, 3]));
      return [enc(new Liar([1, 2, 3])), enc(ext), enc(new DataView(new Liar([4, 5]).buffer))];
    }, ok(['c403010203', 'c703090102 03'.replace(' ', ''), 'c4020405'])],
    ['detached views and buffers encode as empty', () => {
      const buffer = new ArrayBuffer(8);
      const views = [new Uint8Array(buffer), new Float32Array(buffer), new DataView(buffer)];
      structuredClone(buffer, { transfer: [buffer] });
      return [...views, buffer].map((v) => enc(v));
    }, ok(['c400', 'c700fb', 'c400', 'c400'])],
    ['Ext data claiming to be a Uint8Array', () => {
      class Fake extends Uint16Array { get [Symbol.toStringTag]() { return 'Uint8Array'; } }
      return new Ext(1, new Fake(1));
    }, err('invalid_argument', /Ext data must be a Uint8Array/)],
    ['__proto__ stays an own property', () => {
      const v = dec('81a95f5f70726f746f5f5f81a17801');
      return [Object.getPrototypeOf(v) === Object.prototype, Object.keys(v), v.x === undefined];
    }, ok([true, ['__proto__'], true])],

    // --- options ----------------------------------------------------------------------------
    ['encode options null', () => enc(1, null), ok('01')],
    ['decode options null', () => dec('05', null), ok(5)],
    ['encode options not an object', () => enc(1, 5), err('invalid_argument', /encode options must be an object/)],
    ['decode options a string', () => dec('05', 'x'), err('invalid_argument', /decode options must be an object/)],
    ['maxDepth 0', () => [enc(1, { maxDepth: 0 }), outcome(() => enc([], { maxDepth: 0 })).error], ok(['01', 'max_depth'])],
    ['maxDepth above 1000', () => enc(1, { maxDepth: 1001 }), err('invalid_argument', /option maxDepth must be at most 1000, got 1001/)],
    ['maxDepth 1.5', () => dec('05', { maxDepth: 1.5 }), err('invalid_argument', /option maxDepth must be a non-negative integer/)],
    ['compress must be a boolean', () => enc(1, { compress: 'yes' }), err('invalid_argument', /option compress must be a boolean/)],
    ['autoTabular must be a boolean', () => enc(1, { autoTabular: 0 }), err('invalid_argument', /option autoTabular must be a boolean/)],
    ['strict must be a boolean', () => dec('05', { strict: null }), err('invalid_argument', /option strict must be a boolean/)],
    ['autoDecompress must be a boolean', () => dec('05', { autoDecompress: 1 }), err('invalid_argument', /option autoDecompress must be a boolean/)],
    // compression: 'auto' isn't here: the native package keeps it as a deprecated alias for 'zlib'.
    ['an unknown compression algorithm', () => enc(1, { compress: true, compression: 'gzip' }), err('invalid_argument', /option compression must be one of 'zlib', 'lz4', 'zstd', 'brotli', 'snappy'/)],
    ['timestamps mode', () => dec('05', { timestamps: 'iso' }), err('invalid_argument', /option timestamps must be one of 'date', 'object'/)],
    ['bigint mode', () => dec('05', { bigint: 'never' }), err('invalid_argument', /option bigint must be one of 'auto', 'always'/)],
    ['maxValues null', () => dec('05', { maxValues: null }), err('invalid_argument', /option maxValues must be a non-negative integer/)],
    ['maxDecompressedSize -1', () => dec('05', { maxDecompressedSize: -1 }), err('invalid_argument', /option maxDecompressedSize must be a non-negative integer/)],
    ['maxValues 0', () => dec('05', { maxValues: 0 }), err('size_limit')],
    ['codecs must be an object', () => enc(1, { codecs: 5 }), err('invalid_argument', /option codecs must be an object/)],
    ['a codec must be an object', () => dec('05', { codecs: { zlib: 1 } }), err('invalid_argument', /codecs.zlib must be an object/)],
    ['codec functions must be functions', () => enc(1, { codecs: { lz4: { compress: 1 } } }), err('invalid_argument', /codecs.lz4.compress must be a function/)],
    ['hmacKey null', () => enc(1, { hmacKey: null }), err('invalid_argument', /option hmacKey is null; leave it undefined for no key/)],
    ['hmacKey empty', () => dec('05', { hmacKey: '' }), err('invalid_argument', /option hmacKey is empty; leave it undefined for no key/)],
    ['hmacKey a number', () => enc(1, { hmacKey: 42 }), err('invalid_argument', /option hmacKey must be a Uint8Array or a string/)],
    ['hmacKey a Uint16Array', () => enc(1, { hmacKey: new Uint16Array(4) }), err('invalid_argument', /option hmacKey must be a Uint8Array or a string/)],
    ['hmacKey with a lone surrogate', () => enc(1, { hmacKey: 'k\ud800' }), err('invalid_argument', /hmacKey string contains a lone surrogate/)],
    ['hmacKey from another realm', () => {
      const key = vm.runInNewContext('new Uint8Array(16).fill(7)');
      return decode(encode(1, { hmacKey: key }), { hmacKey: new Uint8Array(16).fill(7) });
    }, ok(1)],
    ['signed without a key', () => decode(encode(1, { hmacKey: 'k' })), err('authentication_failed')],
    ['unsigned with a key', () => dec('01', { hmacKey: 'k' }), err('authentication_failed')],
    ['wrong key', () => decode(encode(1, { hmacKey: 'k' }), { hmacKey: 'j' }), err('authentication_failed')],
    ['unknown options are ignored', () => enc(1, { nope: true }), ok('01')],
  ];
}

module.exports = { cases, matches, outcome, show };
