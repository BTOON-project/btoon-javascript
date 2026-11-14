// Typed date (-2) and datetime (-3) values (spec 0.3 §10, DECISIONS D27): BtoonDate and
// BtoonDateTime, what each decoding mode returns, how they encode, and their API. The
// conformance vectors check the bytes too (vectors.test.mjs).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { builds, hex, unhex } from './helpers.mjs';

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const MAX_DATE_MS = 8_640_000_000_000_000;
const be64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v));
  return hex(b);
};

for (const [name, lib] of Object.entries(builds)) {
  const { BtoonDate, BtoonDateTime, BtoonError, Ext, Timestamp, encode, decode } = lib;
  const enc = (v, o) => hex(encode(v, o));
  const dec = (h, o) => decode(unhex(h), o);
  const throwsCode = (fn, code, message) =>
    assert.throws(fn, (e) => {
      assert.ok(e instanceof BtoonError, `expected BtoonError, got ${e}`);
      assert.equal(e.code, code, e.message);
      if (message) assert.match(e.message, message);
      return true;
    });

  describe(`${name}: BtoonDate and BtoonDateTime`, () => {
    test('BtoonDate holds exact milliseconds; seconds and nanoseconds are floored from them', () => {
      for (const [ms, seconds, nanoseconds] of [
        [0n, 0n, 0],
        [1700000000123n, 1700000000n, 123_000_000],
        [-1n, -1n, 999_000_000],
        [-1000n, -1n, 0],
        [-1001n, -2n, 999_000_000],
        [I64_MAX, I64_MAX / 1000n, 807_000_000],
        [I64_MIN, I64_MIN / 1000n - 1n, 192_000_000],
      ]) {
        const d = new BtoonDate(ms);
        assert.equal(d.epochMilliseconds, ms);
        assert.equal(d.seconds, seconds, String(ms));
        assert.equal(d.nanoseconds, nanoseconds, String(ms));
        assert.equal(d.offsetMinutes, undefined);
        assert.equal(Object.getPrototypeOf(d), BtoonDate.prototype);
      }
      assert.equal(new BtoonDate(-5).epochMilliseconds, -5n, 'a safe-integer number');
      assert.equal(new BtoonDate(Number.MAX_SAFE_INTEGER).epochMilliseconds, BigInt(Number.MAX_SAFE_INTEGER));
      assert.equal(new BtoonDate(-0).epochMilliseconds, 0n);
      for (const bad of [I64_MAX + 1n, I64_MIN - 1n, 2 ** 53, 1.5, NaN, Infinity, '5', null, undefined, {}, new Date(0)]) {
        throwsCode(() => new BtoonDate(bad), 'invalid_argument', /BtoonDate epochMilliseconds/);
      }
    });

    test('BtoonDateTime holds exact nanoseconds', () => {
      for (const [ns, seconds, nanoseconds] of [
        [0n, 0n, 0],
        [1700000000123456789n, 1700000000n, 123456789],
        [-1n, -1n, 999_999_999],
        [I64_MAX, 9223372036n, 854775807],
        [I64_MIN, -9223372037n, 145224192],
      ]) {
        const d = new BtoonDateTime(ns);
        assert.equal(d.epochNanoseconds, ns);
        assert.equal(d.seconds, seconds, String(ns));
        assert.equal(d.nanoseconds, nanoseconds, String(ns));
        assert.equal(d.offsetMinutes, undefined);
      }
      assert.equal(new BtoonDateTime(42).epochNanoseconds, 42n);
      for (const bad of [I64_MAX + 1n, I64_MIN - 1n, -(2 ** 53), 0.5, '1', null, undefined, [1]]) {
        throwsCode(() => new BtoonDateTime(bad), 'invalid_argument', /BtoonDateTime epochNanoseconds/);
      }
    });

    test('instanceof: both are Timestamps, neither is the other', () => {
      const d = new BtoonDate(1n);
      const dt = new BtoonDateTime(1n);
      const ts = new Timestamp(1n);
      assert.ok(d instanceof BtoonDate && d instanceof Timestamp && !(d instanceof BtoonDateTime));
      assert.ok(dt instanceof BtoonDateTime && dt instanceof Timestamp && !(dt instanceof BtoonDate));
      assert.ok(!(ts instanceof BtoonDate) && !(ts instanceof BtoonDateTime));
      assert.ok(!(d instanceof Ext) && !(new Date(0) instanceof Timestamp) && !(null instanceof Timestamp));
      for (const v of [5, 'x', undefined, 5n]) assert.ok(!(v instanceof BtoonDate) && !(v instanceof Timestamp));
      // Every copy of the library, and objects from another realm, are recognized by brand.
      for (const other of Object.values(builds)) {
        assert.ok(new other.BtoonDate(1n) instanceof BtoonDate);
        assert.ok(new other.BtoonDateTime(1n) instanceof Timestamp);
        assert.ok(!(new other.Timestamp(1n) instanceof BtoonDateTime));
      }
      const foreign = vm.runInNewContext(
        '({ ts: { [Symbol.for("btoon.Timestamp")]: true }, date: { [Symbol.for("btoon.Timestamp")]: true, [Symbol.for("btoon.Date")]: true } })',
      );
      assert.ok(foreign.ts instanceof Timestamp && !(foreign.ts instanceof BtoonDate));
      assert.ok(foreign.date instanceof BtoonDate && foreign.date instanceof Timestamp);
      // A subclass of these keeps the ordinary instanceof.
      class Day extends BtoonDate {}
      assert.ok(new Day(1n) instanceof Day && new Day(1n) instanceof BtoonDate && !(d instanceof Day));
    });

    test('fromDate and toDate', () => {
      for (const ms of [0, 1700000000123, -1, -62135596800000, MAX_DATE_MS, -MAX_DATE_MS]) {
        const d = BtoonDate.fromDate(new Date(ms));
        assert.ok(d instanceof BtoonDate);
        assert.equal(d.epochMilliseconds, BigInt(ms));
        assert.equal(d.toDate().getTime(), ms);
      }
      assert.equal(BtoonDate.fromDate(vm.runInNewContext('new Date(42)')).epochMilliseconds, 42n, 'a Date from another realm');
      const dt = BtoonDateTime.fromDate(new Date(-1));
      assert.ok(dt instanceof BtoonDateTime);
      assert.equal(dt.epochNanoseconds, -1_000_000n);
      assert.equal(new BtoonDateTime(-1n).toDate().getTime(), -1, 'toDate() floors to the millisecond');
      assert.equal(new BtoonDateTime(1_999_999n).toDate().getTime(), 1);
      // A datetime covers 1677-09-21 to 2262-04-11; Date reaches further.
      throwsCode(() => BtoonDateTime.fromDate(new Date(MAX_DATE_MS)), 'invalid_argument', /range of BtoonDateTime/);
      assert.equal(BtoonDateTime.fromDate(new Date(9223372036854)).epochNanoseconds, 9223372036854000000n);
      throwsCode(() => BtoonDateTime.fromDate(new Date(9223372036855)), 'invalid_argument');
      throwsCode(() => new BtoonDate(MAX_DATE_MS + 1).toDate(), 'invalid_argument', /range of Date/);
      for (const bad of [new Date(NaN), {}, 0, null]) {
        throwsCode(() => BtoonDate.fromDate(bad), 'invalid_argument');
        throwsCode(() => BtoonDateTime.fromDate(bad), 'invalid_argument');
      }
      throwsCode(() => BtoonDate.fromDate(new Date(NaN)), 'invalid_argument', /invalid Date/);
    });

    test('fromTimestamp: a date floors to the millisecond, a datetime is exact', () => {
      assert.equal(BtoonDate.fromTimestamp(new Timestamp(-1n, 999_999_999)).epochMilliseconds, -1n);
      assert.equal(BtoonDate.fromTimestamp(new Timestamp(0n, 999_999)).epochMilliseconds, 0n);
      assert.equal(BtoonDate.fromTimestamp(new Timestamp(1700000000n, 123_456_789)).epochMilliseconds, 1700000000123n);
      assert.equal(BtoonDateTime.fromTimestamp(new Timestamp(1700000000n, 123_456_789)).epochNanoseconds, 1700000000123456789n);
      assert.equal(BtoonDateTime.fromTimestamp(new Timestamp(-1n, 999_999_999)).epochNanoseconds, -1n);
      assert.equal(BtoonDateTime.fromTimestamp(new Timestamp(9223372036n, 854775807)).epochNanoseconds, I64_MAX);
      assert.equal(BtoonDateTime.fromTimestamp(new Timestamp(-9223372037n, 145224192)).epochNanoseconds, I64_MIN);
      // Each converts the other, and Timestamps from other copies of the library.
      assert.equal(BtoonDate.fromTimestamp(new BtoonDateTime(-1n)).epochMilliseconds, -1n);
      assert.equal(BtoonDateTime.fromTimestamp(new BtoonDate(-1n)).epochNanoseconds, -1_000_000n);
      for (const other of Object.values(builds)) {
        assert.equal(BtoonDate.fromTimestamp(new other.Timestamp(2n, 5_000_000)).epochMilliseconds, 2005n);
      }
      // Out of range.
      throwsCode(() => BtoonDate.fromTimestamp(new Timestamp(I64_MAX)), 'invalid_argument', /range of BtoonDate/);
      throwsCode(() => BtoonDate.fromTimestamp(new Timestamp(I64_MIN)), 'invalid_argument');
      throwsCode(() => BtoonDateTime.fromTimestamp(new Timestamp(9223372036n, 854775808)), 'invalid_argument', /range of BtoonDateTime/);
      throwsCode(() => BtoonDateTime.fromTimestamp(new Timestamp(-9223372037n, 145224191)), 'invalid_argument');
      // A date or datetime has no UTC offset, so a Timestamp with one is refused, even 0.
      for (const off of [0, 60, -1080]) {
        throwsCode(() => BtoonDate.fromTimestamp(new Timestamp(0n, 0, off)), 'invalid_argument', /offset/);
        throwsCode(() => BtoonDateTime.fromTimestamp(new Timestamp(0n, 0, off)), 'invalid_argument', /offset/);
      }
      // Not a Timestamp, or one whose fields were changed after construction.
      for (const bad of [new Date(0), { seconds: 0n, nanoseconds: 0 }, 5n, null]) {
        throwsCode(() => BtoonDate.fromTimestamp(bad), 'invalid_argument');
        throwsCode(() => BtoonDateTime.fromTimestamp(bad), 'invalid_argument');
      }
      const changed = new Timestamp(0n);
      changed.nanoseconds = 1e9;
      throwsCode(() => BtoonDate.fromTimestamp(changed), 'invalid_argument');
    });

    test('encode writes fixext 8 with the exact i64, big-endian', () => {
      assert.equal(enc(new BtoonDate(0n)), 'd7fe0000000000000000');
      assert.equal(enc(new BtoonDate(1700000000123n)), 'd7fe0000018bcfe5687b');
      assert.equal(enc(new BtoonDate(-1n)), 'd7feffffffffffffffff');
      assert.equal(enc(new BtoonDate(I64_MAX)), 'd7fe7fffffffffffffff');
      assert.equal(enc(new BtoonDate(I64_MIN)), 'd7fe8000000000000000');
      assert.equal(enc(new BtoonDateTime(1700000000123456789n)), 'd7fd17979cfe3d85cd15');
      assert.equal(enc(new BtoonDateTime(-1n)), 'd7fdffffffffffffffff');
      assert.equal(enc(new BtoonDateTime(I64_MAX)), 'd7fd7fffffffffffffff');
      assert.equal(enc(new BtoonDateTime(I64_MIN)), 'd7fd8000000000000000');
      // The same instant as a Date or Timestamp is still a timestamp (-1).
      assert.equal(enc(new Date(0)), 'd6ff00000000');
      assert.equal(enc(new Timestamp(0n)), 'd6ff00000000');
      assert.equal(enc(BtoonDate.fromDate(new Date(0))), 'd7fe0000000000000000');
      // Inside containers, from other copies of the library, and as table cells (type code 9).
      for (const other of Object.values(builds)) assert.equal(enc([new other.BtoonDate(1n)]), '91d7fe0000000000000001');
      const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, day: new BtoonDate(BigInt(i)), at: new BtoonDateTime(BigInt(-i)) }));
      const table = encode(rows);
      assert.equal(table[0], 0xc7);
      assert.equal(table[2], 0xf6);
      assert.ok(hex(table).includes('090902'), 'type codes: at and day are 9, id is 2');
      const back = decode(table, { timestamps: 'object' });
      assert.deepEqual(back, rows);
      assert.equal(hex(encode(back)), hex(table));
    });

    test('encode checks the epoch field again (it is writable)', () => {
      for (const bad of [2n ** 63n, I64_MIN - 1n, 5, '5', undefined]) {
        const d = new BtoonDate(0n);
        d.epochMilliseconds = bad;
        throwsCode(() => encode(d), 'invalid_argument', /BtoonDate epochMilliseconds/);
        throwsCode(() => encode([{ d }, { d }]), 'invalid_argument');
        const dt = new BtoonDateTime(0n);
        dt.epochNanoseconds = bad;
        throwsCode(() => encode(dt), 'invalid_argument', /BtoonDateTime epochNanoseconds/);
      }
      // The epoch value is what's written; the inherited fields don't matter.
      const d = new BtoonDate(5n);
      d.seconds = 99n;
      assert.equal(enc(d), 'd7fe' + be64(5));
    });

    test("decoding: 'object' mode gives the typed values, 'date' mode a Date when it fits", () => {
      const dateHex = 'd7fe0000018bcfe5687b';
      const dateTimeHex = 'd7fd17979cfe3d85cd15';
      const d = dec(dateHex, { timestamps: 'object' });
      assert.equal(Object.getPrototypeOf(d), BtoonDate.prototype);
      assert.equal(d.epochMilliseconds, 1700000000123n);
      const dt = dec(dateTimeHex, { timestamps: 'object' });
      assert.equal(Object.getPrototypeOf(dt), BtoonDateTime.prototype);
      assert.equal(dt.epochNanoseconds, 1700000000123456789n);
      const ts = dec('d6ff00000000', { timestamps: 'object' });
      assert.equal(Object.getPrototypeOf(ts), Timestamp.prototype, 'a timestamp stays a plain Timestamp');
      // The default 'date' mode is unchanged: Date, floored to the millisecond.
      assert.equal(dec(dateHex).getTime(), 1700000000123);
      assert.equal(dec(dateTimeHex).getTime(), 1700000000123);
      assert.equal(dec('d7fdffffffffffffffff').getTime(), -1);
      assert.equal(dec('d7fd' + be64(I64_MIN)).getTime(), -9223372036855, 'every datetime fits in a Date');
      // A date outside the range of Date falls back to a BtoonDate, keeping its type.
      for (const ms of [I64_MAX, I64_MIN, BigInt(MAX_DATE_MS) + 1n, -BigInt(MAX_DATE_MS) - 1n]) {
        const far = dec('d7fe' + be64(ms));
        assert.equal(Object.getPrototypeOf(far), BtoonDate.prototype, String(ms));
        assert.equal(far.epochMilliseconds, ms);
      }
      assert.equal(dec('d7fe' + be64(MAX_DATE_MS)).getTime(), MAX_DATE_MS);
      assert.equal(dec('d7fe' + be64(-MAX_DATE_MS)).getTime(), -MAX_DATE_MS);
      // Malformed payloads.
      for (const bad of ['d6fe00000000', 'c709fe000000000000000000', 'd6fd00000000']) assert.throws(() => dec(bad), /length/);
    });

    test('decode then encode writes the same bytes, also in tables and nested', () => {
      const docs = [
        'd7fe0000018bcfe5687b',
        'd7fd17979cfe3d85cd15',
        '93d7fe8000000000000000d7fd7fffffffffffffffd6ff65920080',
        enc({ day: new BtoonDate(-86400000n), at: new BtoonDateTime(1n), ts: new Timestamp(-1n, 5, 60) }),
        enc(Array.from({ length: 4 }, (_, i) => ({ d: new BtoonDate(BigInt(i) * 86400000n), n: i }))),
      ];
      for (const doc of docs) assert.equal(hex(encode(dec(doc, { timestamps: 'object' }))), doc);
      // The out-of-range fallback re-encodes as a date, in 'date' mode too.
      assert.equal(enc(dec('d7fe7fffffffffffffff')), 'd7fe7fffffffffffffff');
    });

    test('raw Ext(-2) and Ext(-3) stay refused; the message names the typed values', () => {
      throwsCode(() => encode(new Ext(-2, new Uint8Array(8))), 'invalid_argument', /BtoonDate\b/);
      throwsCode(() => encode(new Ext(-3, new Uint8Array(8))), 'invalid_argument', /BtoonDateTime/);
      throwsCode(() => encode(new Ext(-1, new Uint8Array(4))), 'invalid_argument', /Date or Timestamp/);
    });
  });
}
