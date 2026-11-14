// Regression tests for the @btoon/js findings of review 2026-11-13 fixed in 0.3.0 (see
// CHANGELOG.md), plus the ones fixed earlier that still lacked a test of their own.
// Shared-memory input is in shared-input.test.mjs, which needs a process of its own.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { builds, hex } from './helpers.mjs';

const libs = Object.entries(builds);

describe('instanceof across copies of the library (dual-package hazard)', () => {
  test('Timestamp, Ext and BtoonError from one build are instances of every other build', () => {
    for (const [a, A] of libs) {
      const ts = A.decode(A.encode(new A.Timestamp(1n, 5)), { timestamps: 'object' });
      const ext = A.decode(A.encode(new A.Ext(7, Uint8Array.of(1))));
      let err;
      try {
        A.decode(Uint8Array.of(0xc1));
      } catch (e) {
        err = e;
      }
      for (const [b, B] of libs) {
        const what = `${a} → ${b}`;
        assert.ok(ts instanceof B.Timestamp, what);
        assert.ok(ext instanceof B.Ext, what);
        assert.ok(err instanceof B.BtoonError && err instanceof Error, what);
        assert.equal(err.code, 'invalid_marker');
        assert.ok(!(ts instanceof B.Ext) && !(ext instanceof B.Timestamp) && !(err instanceof B.Timestamp), what);
        assert.ok(!(new Error('x') instanceof B.BtoonError) && !({ code: 'truncated' } instanceof B.BtoonError), what);
        // The library's own checks see them too: encoding a Timestamp or Ext from another copy.
        assert.equal(hex(B.encode(ts)), 'd7ff0000001400000001', what);
        assert.equal(hex(B.encode(ext)), 'd40701', what);
      }
    }
  });

  test('a subclass keeps the ordinary instanceof; branded objects from another realm count', () => {
    const { BtoonError, Ext, Timestamp } = builds['esm/node'];
    class AppError extends BtoonError {}
    const e = new AppError('truncated', 'x');
    assert.ok(e instanceof AppError && e instanceof BtoonError && e instanceof builds['cjs/portable'].BtoonError);
    assert.ok(!(new BtoonError('truncated', 'x') instanceof AppError));
    class Tagged extends Ext {}
    assert.ok(new Tagged(1, new Uint8Array(0)) instanceof Tagged && !(new Ext(1, new Uint8Array(0)) instanceof Tagged));
    const foreign = vm.runInNewContext(
      '({ err: Object.assign(new Error("x"), { [Symbol.for("btoon.BtoonError")]: true }), ts: { [Symbol.for("btoon.Timestamp")]: true } })',
    );
    assert.ok(foreign.err instanceof BtoonError);
    assert.ok(foreign.ts instanceof Timestamp);
  });
});

for (const [name, lib] of libs) {
  const { BtoonError, Ext, Timestamp, decode, encode } = lib;
  const enc = (v, o) => hex(encode(v, o));
  const throwsCode = (fn, code) =>
    assert.throws(fn, (e) => {
      assert.ok(e instanceof BtoonError, `expected BtoonError, got ${e}`);
      assert.equal(e.code, code, e.message);
      return true;
    });

  describe(`${name}: review 2026-11-13 fixes`, () => {
    test('a plain object with its own toJSON() is encoded by it, as JSON.stringify does', () => {
      assert.equal(enc({ toJSON: () => 'X' }), enc('X'));
      assert.equal(enc({ a: { toJSON() { return [1, 2]; } } }), enc({ a: [1, 2] }));
      assert.equal(enc(Object.assign(Object.create(null), { toJSON: () => 7 })), '07');
      assert.equal(enc(new Map([['k', { toJSON: () => null }]])), enc({ k: null }));
      assert.equal(enc({ toJSON() {} }), 'c0', 'undefined is nil');
      // As rows of a table, and as its cells.
      const rows = Array.from({ length: 10 }, (_, i) => ({ toJSON: () => ({ id: i, name: `n${i}` }) }));
      assert.equal(encode(rows)[0], 0xc7);
      assert.equal(enc(rows), enc(rows.map((r) => r.toJSON())));
      const cells = Array.from({ length: 10 }, (_, i) => ({ id: i, when: { toJSON: () => `t${i}` } }));
      assert.equal(enc(cells), enc(cells.map((r) => ({ id: r.id, when: `t${r.id}` }))));
      // Called once per value. A result's own toJSON() isn't called: it is a function property.
      let calls = 0;
      const counted = { toJSON: () => (calls++, { v: 1 }) };
      encode([counted, counted, { x: counted }, Array.from({ length: 4 }, () => counted)]);
      assert.equal(calls, 7);
      throwsCode(() => encode({ toJSON: () => ({ toJSON: () => 1 }) }), 'invalid_argument');
      // A toJSON() doesn't count as a nesting level (128 arrays, then a toJSON leaf).
      let deep = { toJSON: () => 'leaf' };
      for (let i = 0; i < 128; i++) deep = [deep];
      assert.equal(encode(deep).length, 128 + 5);
      // Its exceptions propagate unchanged.
      const mine = new RangeError('mine');
      assert.throws(() => encode({ a: { toJSON() { throw mine; } } }), (e) => e === mine);
      // Only an own toJSON counts: a polluted Object.prototype.toJSON is ignored.
      Object.prototype.toJSON = () => 'polluted';
      try {
        assert.equal(enc({ a: 1 }), '81a16101');
        assert.equal(enc([{ a: 1 }, { a: 2 }], { autoTabular: false }), '9281a1610181a16102');
      } finally {
        delete Object.prototype.toJSON;
      }
    });

    test('getters that change the rows while a table is written', () => {
      // They used to throw a raw TypeError. The table is written from the rows as they were
      // when it was planned; each cell is read when it is written.
      const emptied = [];
      for (let i = 0; i < 10; i++) emptied.push({ a: i, get b() { emptied.length = 0; return i; } });
      assert.deepEqual(decode(encode(emptied)), Array.from({ length: 10 }, (_, i) => ({ a: i, b: i })));
      const swapped = Array.from({ length: 10 }, (_, i) => new Map([['a', i], ['b', i]]));
      swapped[0] = { a: 0, get b() { swapped[5] = { a: 'x', b: 'y' }; return 0; } };
      assert.deepEqual(decode(encode(swapped))[5], { a: 5, b: 5 });
      const nulled = Array.from({ length: 10 }, (_, i) => ({ a: i, b: i }));
      Object.defineProperty(nulled[0], 'b', { get() { nulled[3] = null; return 0; }, enumerable: true });
      assert.deepEqual(decode(encode(nulled))[3], { a: 3, b: 3 });
      // A cell read after its row lost the key is nil.
      const shrunk = Array.from({ length: 10 }, (_, i) => ({ a: i, b: i }));
      Object.defineProperty(shrunk[0], 'a', { get() { delete shrunk[9].b; return 0; }, enumerable: true });
      assert.deepEqual(decode(encode(shrunk))[9], { a: 9, b: null });
    });

    test('new Timestamp(seconds) defaults nanoseconds to 0', () => {
      assert.deepEqual(new Timestamp(5n), new Timestamp(5n, 0));
      assert.equal(new Timestamp(5).nanoseconds, 0);
      assert.equal(new Timestamp(5n, undefined, 60).nanoseconds, 0);
      assert.equal(enc(new Timestamp(5n)), 'd6ff00000005');
      throwsCode(() => new Timestamp(5n, null), 'invalid_argument');
    });

    test('Ext data replaced by something other than a Uint8Array is refused (fixed in 0.2.0)', () => {
      for (const data of [new Float32Array([1.5, 2.5]), new DataView(new ArrayBuffer(4)), new Uint16Array([0x0102]), 'abc', [1, 2], null]) {
        const e = new Ext(7, new Uint8Array(1));
        e.data = data;
        throwsCode(() => encode([e, 'after']), 'invalid_argument');
        throwsCode(() => new Ext(7, data), 'invalid_argument');
      }
      const e = new Ext(7, new Uint8Array(1));
      e.data = Buffer.from([1, 2]);
      assert.equal(enc(e), 'd5070102', 'a Buffer is a Uint8Array');
    });

    test("Maps: a subclass can't repeat a key, and proxied (reactive) Maps encode like their targets", () => {
      class Repeating extends Map {
        *[Symbol.iterator]() {
          yield ['a', 1];
          yield ['a', 2];
        }
        *entries() {
          yield* this[Symbol.iterator]();
        }
        *keys() {
          yield 'a';
          yield 'a';
        }
        get() {
          return 'overridden';
        }
      }
      // Read with the intrinsic Map methods, never the subclass's: one key, its real value.
      assert.equal(enc(new Repeating([['a', 0]])), '81a16100');
      assert.equal(enc([new Repeating([['a', 0]]), new Repeating([['a', 0]])], { autoTabular: false }), '9281a1610081a16100');
      // Vue's and MobX's reactive Maps trap `get` and run the Map's methods on the target.
      const reactive = (target) =>
        new Proxy(target, {
          get(t, key) {
            const v = Reflect.get(t, key, t);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      assert.equal(enc(reactive(new Map([['b', 1], ['a', [2]]]))), enc({ a: [2], b: 1 }));
      const table = Array.from({ length: 8 }, (_, i) => reactive(new Map([['id', i], ['name', `n${i}`]])));
      assert.equal(enc(table), enc(table.map((m, i) => ({ id: i, name: `n${i}` }))));
      assert.equal(encode(table)[0], 0xc7);
      throwsCode(() => encode(reactive(new Map([[1, 'x']]))), 'invalid_argument');
      // A proxy whose own keys() repeats a key is refused rather than written twice.
      const lying = new Proxy(new Map([['a', 1]]), {
        get(t, key) {
          if (key === 'keys') return () => ['a', 'a'][Symbol.iterator]();
          const v = Reflect.get(t, key, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      throwsCode(() => encode(lying), 'invalid_argument');
      throwsCode(() => encode([lying, lying]), 'invalid_argument');
      // A bare Proxy of a Map can't run the Map methods: their TypeError, as before.
      assert.throws(() => encode(new Proxy(new Map([['a', 1]]), {})), TypeError);
      assert.throws(() => encode(Object.create(Map.prototype)), TypeError);
      // A spoofed toStringTag doesn't make a Map.
      assert.equal(enc({ [Symbol.toStringTag]: 'Map', a: 1 }), '81a16101');
    });

    test("a Proxy of an array must report a valid length", () => {
      for (const length of [-1, 1.5, 2 ** 32, 'x', undefined]) {
        const arr = new Proxy([1, 2], { get: (t, k) => (k === 'length' ? length : Reflect.get(t, k)) });
        throwsCode(() => encode(arr), 'invalid_argument');
      }
      assert.equal(enc(new Proxy([1, 2], {})), '920102');
    });
  });
}
