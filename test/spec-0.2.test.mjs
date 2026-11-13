// Spec 0.2 (D23–D25): the max_values limit and how values are counted (SPEC §7.1), the
// tabular key-byte bound and header order (§5.6.3), the 64 MiB default for
// maxDecompressedSize, the maxDepth ceiling (§7), UTF-8 map keys and column names in
// non-strict mode, raw extensions with BTOON-defined ids (§5.7), zlib FDICT (§6), and empty
// or null HMAC keys (§8, see also envelope.test.mjs).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { inflateZlib } from '../dist/esm/inflate.js';
import { nodePlatform } from '../dist/esm/platform-node.js';
import { portablePlatform } from '../dist/esm/platform-portable.js';
import { builds, compressionEnvelope, hex, unhex, verdict } from './helpers.mjs';

const node = builds['esm/node'];
const portable = builds['esm/portable'];
const MiB = 1024 * 1024;

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const utf8 = (s) => new TextEncoder().encode(s);

/**
 * A tabular extension (SPEC §5.6.1) from raw parts: `names` are byte arrays (or strings),
 * `columns` are arrays of encoded cells. `rows` defaults to the length of the first column.
 */
function tabular(names, columns, { rows = columns[0]?.length ?? 0 } = {}) {
  const parts = [...be32(1), ...be32(names.length), ...be32(rows)];
  for (const n of names) {
    const b = typeof n === 'string' ? utf8(n) : Uint8Array.from(n);
    parts.push(...be32(b.length), ...b);
  }
  parts.push(...names.map(() => 0));
  for (const col of columns) {
    const bytes = col.flatMap((c) => [...c]);
    parts.push(...be32(bytes.length), ...bytes);
  }
  const n = parts.length;
  const head = n <= 0xff ? [0xc7, n, 0xf6] : n <= 0xffff ? [0xc8, n >> 8, n & 255, 0xf6] : [0xc9, ...be32(n), 0xf6];
  return Uint8Array.from([...head, ...parts]);
}

/** The code of the BtoonError a synchronous call throws, or 'ok'. */
function codeOf(fn) {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (e?.name !== 'BtoonError') throw e;
    return e.code;
  }
}

/**
 * How many values `bytes` decodes to, by SPEC §7.1's count: the smallest maxValues that
 * decodes it. One less must fail with size_limit.
 */
function valuesIn(lib, bytes, options = {}) {
  for (let k = 0; k < 10000; k++) {
    const code = codeOf(() => lib.decode(bytes, { ...options, maxValues: k }));
    if (code === 'ok') return k;
    assert.equal(code, 'size_limit', `maxValues ${k}: ${hex(bytes.subarray(0, 32))}`);
  }
  assert.fail('more than 10000 values');
}

describe('maxValues (SPEC §7.1)', () => {
  test('a value counts once, when it starts; map keys and envelopes do not count', () => {
    const cases = [
      ['c0', 1],
      ['93010203', 4],
      ['90', 1],
      ['80', 1],
      ['81a1619101', 3], // the map, its value, and the array's element: keys don't count
      ['83a161c0a162c0a163c0', 4],
      ['9291019102', 5],
      // Every extension value counts once, whatever its type; its payload is not values.
      ['d6ff65920080', 1], // timestamp
      ['d7fe0000018bcfe5687b', 1], // date
      ['d7fdffffffffffffffff', 1], // datetime
      ['c709fc010000000000000000', 1], // bigint
      ['d7fb0000803f00000040', 1], // float32 vector of two elements
      ['d8fa000000000000f03f0000000000000040', 1], // float64 vector
      ['d401aa', 1], // application extension
      ['d4f501', 1], // an id reserved for future versions
      ['92d6ff65920080d401aa', 3],
    ];
    for (const lib of [node, portable]) {
      for (const [h, n] of cases) {
        for (const options of [{}, { timestamps: 'object', bigint: 'always' }, { strict: false }]) {
          assert.equal(valuesIn(lib, unhex(h), options), n, `${h} ${JSON.stringify(options)}`);
        }
      }
      const doc = lib.encode({ rows: Array.from({ length: 40 }, (_, i) => ({ i, s: 'x'.repeat(i) })), more: [1, [2, [3]]] });
      const bare = valuesIn(lib, doc);
      // 1 map + 1 table + 40 rows + 80 cells + the "more" array (1 + 2 + 1 + 2).
      assert.equal(bare, 1 + 1 + 40 + 80 + 6);
      // Values inside a compression or signed envelope count; the envelopes don't.
      const key = utf8('k'.repeat(32));
      const compressed = node.encode(lib.decode(doc), { compress: true });
      assert.equal(compressed[0], 0x42, 'compressed');
      assert.equal(valuesIn(lib, compressed), bare);
      assert.equal(valuesIn(lib, node.encode(lib.decode(doc), { compress: true, hmacKey: key }), { hmacKey: key }), bare);
    }
  });

  test('a tabular array counts itself, then its rows at the header, then each cell', () => {
    const t22 = tabular(['a', 'b'], [[unhex('01'), unhex('02')], [unhex('03'), unhex('04')]]);
    const empty = tabular([], [], { rows: 0 });
    const noRows = tabular(['a', 'b'], [[], []]);
    const nested = tabular(['t'], [[t22, t22, t22]]); // 1 + 3 rows + 3 × 7
    for (const lib of [node, portable]) {
      assert.equal(valuesIn(lib, t22), 7);
      assert.equal(valuesIn(lib, empty), 1);
      assert.equal(valuesIn(lib, noRows), 1);
      assert.equal(valuesIn(lib, nested), 1 + 3 + 3 * 7);
      assert.deepEqual(lib.decode(nested, { maxValues: 25 }), Array(3).fill({ t: [{ a: 1, b: 3 }, { a: 2, b: 4 }] }));
      // A tabular counts like the equivalent plain array of maps.
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `n${i}` }));
      assert.equal(valuesIn(lib, lib.encode(rows)), valuesIn(lib, lib.encode(rows, { autoTabular: false })));
    }
  });

  test('the limit is checked as each value starts, before anything else about it', () => {
    for (const lib of [node, portable]) {
      const dec = (h, o) => codeOf(() => lib.decode(unhex(h), o));
      // Before its marker is examined (vector limits/counted-when-value-starts) ...
      assert.equal(dec('9201c1', { maxValues: 2 }), 'size_limit');
      assert.equal(dec('9201c1', { maxValues: 3 }), 'invalid_marker');
      // ... before the input is found to end ...
      assert.equal(dec('', { maxValues: 0 }), 'size_limit');
      assert.equal(dec('', { maxValues: 1 }), 'truncated');
      assert.equal(dec('9201cb00', { maxValues: 2 }), 'size_limit'); // a float64 cut short
      assert.equal(dec('9201cb00', { maxValues: 3 }), 'truncated');
      assert.equal(dec('9201', { maxValues: 1 }), 'truncated'); // an announced count is checked first
      // ... and before a container's depth check.
      assert.equal(dec('9191c0', { maxDepth: 1, maxValues: 1 }), 'size_limit');
      assert.equal(dec('9191c0', { maxDepth: 1, maxValues: 2 }), 'max_depth');
      const t = hex(tabular(['a'], [[unhex('c0')]]));
      assert.equal(dec(t, { maxDepth: 1, maxValues: 0 }), 'size_limit');
      assert.equal(dec(t, { maxDepth: 1, maxValues: 1 }), 'max_depth');
      // A map key is not a value: its errors aren't preempted.
      assert.equal(dec('81c101', { maxValues: 1 }), 'non_string_key');
      assert.equal(dec('81a1ff01', { maxValues: 1 }), 'invalid_utf8');
      assert.equal(dec('81a16101', { maxValues: 1 }), 'size_limit');
    }
  });

  test('a table checks its header before counting its rows (SPEC §5.6.3)', () => {
    const c0 = unhex('c0');
    for (const lib of [node, portable]) {
      const dec = (bytes, o) => {
        try {
          lib.decode(bytes, o);
          return 'ok';
        } catch (e) {
          return `${e.code}${e.code === 'size_limit' ? (e.message.includes('maxValues') ? ' (values)' : ' (names)') : ''}`;
        }
      };
      // Rows are counted once the header is checked, before the first cell (which is c1).
      const rowsFirst = unhex('c718f600000001000000010000000200000001610000000002c1c0');
      assert.equal(dec(rowsFirst, { maxValues: 2 }), 'size_limit (values)');
      assert.equal(dec(rowsFirst, { maxValues: 3 }), 'size_limit (values)'); // the first cell
      assert.equal(dec(rowsFirst, { maxValues: 4 }), 'invalid_marker');
      // Column names (UTF-8, then duplicates), N × C, and the name bytes all come first.
      assert.equal(dec(tabular([[0xff]], [[c0]]), { maxValues: 1 }), 'invalid_utf8');
      assert.equal(dec(tabular(['a', 'a'], [[c0], [c0]]), { maxValues: 1 }), 'invalid_tabular');
      assert.equal(dec(tabular(['a'], [[c0]], { rows: 6 }), { maxValues: 1 }), 'invalid_tabular'); // 6 cells, 5 bytes
      assert.equal(dec(tabular(['a'], [[c0]], { rows: 5 }), { maxValues: 1 }), 'size_limit (values)');
      const named = tabular(['abc'], [[c0, c0]]);
      assert.equal(dec(named, { maxValues: 1, maxDecompressedSize: 5 }), 'size_limit (names)');
      assert.equal(dec(named, { maxValues: 1, maxDecompressedSize: 6 }), 'size_limit (values)');
      assert.equal(dec(named, { maxValues: 3, maxDecompressedSize: 6 }), 'size_limit (values)');
      assert.equal(dec(named, { maxValues: 5, maxDecompressedSize: 6 }), 'ok');
      // The table itself counts before its header is read.
      assert.equal(dec(unhex('d7f60000000100000001'), { maxValues: 0 }), 'size_limit (values)');
      assert.equal(dec(unhex('d7f60000000100000001'), { maxValues: 1 }), 'invalid_tabular');
    }
  });

  test('the default is 2^20, and the limit can be raised', () => {
    // An array of n nils is n + 1 values.
    const nils = (n) => {
      const b = new Uint8Array(5 + n).fill(0xc0);
      b.set([0xdd, ...be32(n)]);
      return b;
    };
    const atLimit = nils(2 ** 20 - 1);
    const over = nils(2 ** 20);
    for (const lib of [node, portable]) {
      assert.equal(lib.decode(atLimit).length, 2 ** 20 - 1);
      assert.equal(codeOf(() => lib.decode(over)), 'size_limit');
      assert.equal(lib.decode(over, { maxValues: 2 ** 20 + 1 }).length, 2 ** 20);
      assert.equal(codeOf(() => lib.decode(over, { maxValues: 2 ** 20 })), 'size_limit');
    }
  });

  test('every entry point applies it, synchronous and asynchronous', async () => {
    const doc = unhex('93010203');
    const compressed = compressionEnvelope(0, zlib.deflateSync(doc), doc.length);
    for (const [name, lib] of Object.entries(builds)) {
      for (const bytes of [doc, compressed]) {
        assert.deepEqual(await verdict(() => lib.decode(bytes, { maxValues: 3 })), { code: 'size_limit' }, name);
        assert.deepEqual(await verdict(() => lib.decodeAsync(bytes, { maxValues: 3 })), { code: 'size_limit' }, name);
        assert.deepEqual(await lib.decodeAsync(bytes, { maxValues: 4 }), [1, 2, 3], name);
      }
    }
  });

  test('a hostile envelope fails with size_limit within a 256 MB heap', async () => {
    // 64 MiB of empty maps in one array: the most a default-sized envelope can expand to.
    // 0.1.x built every map (gigabytes, a fatal out-of-memory error); now decoding stops at
    // the 2^20th value.
    const doc = new Uint8Array(64 * MiB).fill(0x80);
    doc.set([0xdd, ...be32(doc.length - 5)]);
    const bomb = compressionEnvelope(0, zlib.deflateSync(doc, { level: 9 }), doc.length);
    assert.ok(bomb.length < 100 * 1024, `${bomb.length} bytes`);
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.entry).then((lib) => {
        try {
          lib.decode(workerData.bomb);
          parentPort.postMessage('ok');
        } catch (e) {
          parentPort.postMessage(e.code ?? String(e));
        }
      });`;
    for (const entry of ['../dist/esm/node.js', '../dist/esm/index.js']) {
      const result = await new Promise((resolve) => {
        const worker = new Worker(code, {
          eval: true,
          workerData: { entry: new URL(entry, import.meta.url).href, bomb },
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        });
        worker.once('message', resolve);
        worker.once('error', (e) => resolve(e.code ?? String(e)));
      });
      assert.equal(result, 'size_limit', entry);
    }
  });
});

describe('tabular column names (SPEC §5.6.3)', () => {
  test('rows × name bytes above maxDecompressedSize is size_limit', () => {
    const c0 = unhex('c0');
    // "é" is 2 bytes (1 UTF-16 unit) and "😀" 4 bytes (2 units): 6 bytes per row, 24 in all.
    const t = tabular(['é', '😀'], [[c0, c0, c0, c0], [c0, c0, c0, c0]]);
    for (const lib of [node, portable]) {
      for (const strict of [true, false]) {
        assert.equal(lib.decode(t, { maxDecompressedSize: 24, strict }).length, 4);
        assert.equal(codeOf(() => lib.decode(t, { maxDecompressedSize: 23, strict })), 'size_limit');
      }
      // Nested in a plain document, and inside an envelope, where the same limit applies.
      assert.equal(codeOf(() => lib.decode(Uint8Array.from([0x91, ...t]), { maxDecompressedSize: 23 })), 'size_limit');
      const env = compressionEnvelope(0, zlib.deflateSync(t), t.length);
      assert.equal(lib.decode(env, { maxDecompressedSize: t.length }).length, 4);
      assert.equal(codeOf(() => lib.decode(env, { maxDecompressedSize: 23 })), 'size_limit');
      // Empty names copy nothing.
      assert.equal(lib.decode(tabular([''], [[c0, c0, c0]]), { maxDecompressedSize: 0 }).length, 3);
    }
  });

  test('the default bound is 64 MiB of copied names', () => {
    // One 8 KiB name: 8,192 rows copy exactly 64 MiB; 8,193 rows copy more. 0.1.x decoded both.
    const name = 'n'.repeat(8192);
    const table = (rows) => tabular([name], [Array(rows).fill(unhex('c0'))]);
    for (const lib of [node, portable]) {
      assert.equal(lib.decode(table(8192)).length, 8192);
      assert.equal(codeOf(() => lib.decode(table(8193))), 'size_limit');
      assert.equal(lib.decode(table(8193), { maxDecompressedSize: 64 * MiB + 8192 }).length, 8193);
    }
  });

  test('names are checked front to back: UTF-8 first, then against the earlier names', () => {
    const c0 = [unhex('c0')];
    const FF = [0xff];
    const cases = [
      [['a', 'a', FF], 'invalid_tabular'], // vector tabular/duplicate-before-invalid-utf8
      [[FF, 'a', 'a'], 'invalid_utf8'], // vector tabular/invalid-utf8-before-duplicate
      [['a', 'b', 'a', FF], 'invalid_tabular'],
      [['a', FF, 'a'], 'invalid_utf8'],
      [['b', 'a', 'c', 'b'], 'invalid_tabular'],
      // Distinct invalid names would merge if U+FFFD replaced them; they fail as UTF-8.
      [[FF, [0xfe]], 'invalid_utf8'],
      [[[0x61, 0xff], [0x61, 0xfe]], 'invalid_utf8'],
      [['é', [0x65, 0xcc, 0x81]], 'ok'], // NFC and NFD differ by bytes: two columns
    ];
    for (const lib of [node, portable]) {
      for (const [names, expected] of cases) {
        const t = tabular(names, names.map(() => c0));
        for (const strict of [true, false]) {
          assert.equal(codeOf(() => lib.decode(t, { strict })), expected, `${JSON.stringify(names)} strict ${strict}`);
        }
      }
      assert.deepEqual(Object.keys(lib.decode(tabular(['é', [0x65, 0xcc, 0x81]], [c0, c0]))[0]), ['é', 'é']);
    }
  });
});

describe('UTF-8 in non-strict mode (SPEC §7)', () => {
  test('map keys must be valid UTF-8; string values may be replaced', () => {
    for (const lib of [node, portable]) {
      const dec = (h, o) => codeOf(() => lib.decode(unhex(h), o));
      for (const strict of [true, false]) {
        assert.equal(dec('81a1ff01', { strict }), 'invalid_utf8');
        assert.equal(dec('82a1ff01a1fe02', { strict }), 'invalid_utf8'); // would merge into one U+FFFD key
        assert.equal(dec(`81d920${'ff'.repeat(32)}01`, { strict }), 'invalid_utf8'); // a long key
        assert.equal(dec('81a3eda08001', { strict }), 'invalid_utf8'); // a surrogate
        assert.equal(dec('81a2c08001', { strict }), 'invalid_utf8'); // overlong
      }
      assert.deepEqual(lib.decode(unhex('82a16101a16102'), { strict: false }), { a: 2 }, 'valid duplicates: last wins');
      assert.deepEqual(lib.decode(unhex('81a161a2c328'), { strict: false }), { a: '�(' });
      assert.equal(dec('81a161a2c328'), 'invalid_utf8');
    }
  });
});

describe('maxDecompressedSize default (SPEC §7.1)', () => {
  test('is 64 MiB', async () => {
    const tiny = zlib.deflateSync(new Uint8Array(10));
    for (const [name, lib] of Object.entries(builds)) {
      for (const decode of [(b, o) => lib.decode(b, o), (b, o) => lib.decodeAsync(b, o)]) {
        // Exactly 64 MiB passes the header check (and then fails as a size mismatch).
        assert.deepEqual(await verdict(() => decode(compressionEnvelope(0, tiny, 64 * MiB))), { code: 'invalid_envelope' }, name);
        assert.deepEqual(await verdict(() => decode(compressionEnvelope(0, tiny, 64 * MiB + 1))), { code: 'size_limit' }, name);
        assert.deepEqual(
          await verdict(() => decode(compressionEnvelope(0, tiny, 64 * MiB + 1), { maxDecompressedSize: 256 * MiB })),
          { code: 'invalid_envelope' },
          name,
        );
      }
    }
  });
});

describe('maxDepth ceiling (SPEC §7)', () => {
  test('above 1000 is invalid_argument on every entry point', async () => {
    let deep = null;
    for (let i = 0; i < 1000; i++) deep = [deep];
    const bytes = new Uint8Array(1001).fill(0x91);
    bytes[1000] = 0xc0;
    for (const [name, lib] of Object.entries(builds)) {
      for (const maxDepth of [1001, 5000, 2 ** 31]) {
        assert.equal(codeOf(() => lib.encode(1, { maxDepth })), 'invalid_argument', name);
        assert.equal(codeOf(() => lib.decode(unhex('01'), { maxDepth })), 'invalid_argument', name);
        assert.deepEqual(await verdict(() => lib.encodeAsync(1, { maxDepth })), { code: 'invalid_argument' }, name);
        assert.deepEqual(await verdict(() => lib.decodeAsync(unhex('01'), { maxDepth })), { code: 'invalid_argument' }, name);
      }
      // 1000 is allowed, and that much nesting fits the stack in both directions.
      assert.equal(lib.encode(deep, { maxDepth: 1000 }).length, 1001);
      assert.equal(lib.decode(bytes, { maxDepth: 1000 }).length, 1);
      assert.equal((await lib.encodeAsync(deep, { maxDepth: 1000 })).length, 1001);
      assert.equal((await lib.decodeAsync(bytes, { maxDepth: 1000 })).length, 1);
      assert.equal(codeOf(() => lib.decode(Uint8Array.from([0x91, ...bytes]), { maxDepth: 1000 })), 'max_depth');
    }
  });

  test('a call stack that runs out anyway is reported as max_depth', () => {
    // Calls fn() with as little stack as it can start with: from the deepest frame up, one
    // frame at a time, until no RangeError escapes. The first call that gets through ran
    // out of stack inside the library, which must report max_depth (on Node.js 24 and 26 it
    // leaked a SyntaxError from compiling a regular expression with no stack left).
    const nearStackLimit = (fn) => {
      const down = () => {
        try {
          return down();
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
        return fn();
      };
      return down();
    };
    let deep = null;
    for (let i = 0; i < 1000; i++) deep = [deep];
    const bytes = new Uint8Array(1001).fill(0x91);
    bytes[1000] = 0xc0;
    for (const lib of [node, portable]) {
      for (let i = 0; i < 3; i++) {
        assert.equal(nearStackLimit(() => codeOf(() => lib.decode(bytes, { maxDepth: 1000 }))), 'max_depth');
        assert.equal(nearStackLimit(() => codeOf(() => lib.encode(deep, { maxDepth: 1000 }))), 'max_depth');
      }
    }
  });
});

describe('raw extensions with BTOON-defined ids (SPEC §5.7)', () => {
  test('are rejected with invalid_argument on every entry point', async () => {
    const defined = [-1, -2, -3, -4, -5, -6, -10];
    for (const [name, lib] of Object.entries(builds)) {
      for (const type of defined) {
        for (const ExtClass of [lib.Ext, builds['cjs/portable'].Ext]) {
          const e = new ExtClass(type, new Uint8Array(8));
          for (const value of [e, [e], { k: e }, new Map([['k', e]]), Array.from({ length: 12 }, (_, i) => ({ i, e }))]) {
            assert.equal(codeOf(() => lib.encode(value)), 'invalid_argument', `${name} Ext(${type})`);
            assert.deepEqual(await verdict(() => lib.encodeAsync(value)), { code: 'invalid_argument' }, `${name} Ext(${type})`);
          }
        }
      }
      // Reserved and application ids are written as given.
      for (const type of [-7, -8, -9, -11, -64, -128, 0, 1, 127]) {
        const out = lib.encode(new lib.Ext(type, Uint8Array.of(7)));
        assert.equal(hex(out), `d4${(type & 0xff).toString(16).padStart(2, '0')}07`, `${name} Ext(${type})`);
        assert.equal(lib.decode(out).type, type);
      }
    }
  });
});

describe('zlib preset dictionaries (SPEC §6)', () => {
  // The vector's stream (FDICT with DICTID 1, the Adler-32 of an empty dictionary), the same
  // with FLEVEL 2, and a real stream with a DICTID spliced in: a decoder that skipped the
  // DICTID would accept the last one.
  const doc = node.encode({ msg: 'z'.repeat(300) });
  const real = zlib.deflateSync(doc);
  const fdict = (stream, dictId) => {
    const cmf = stream[0];
    let flg = (stream[1] & 0xc0) | 0x20;
    flg |= (31 - (((cmf << 8) | flg) % 31)) % 31;
    return Uint8Array.from([cmf, flg, ...be32(dictId), ...stream.subarray(2)]);
  };
  const payloads = [
    ['vector envelope/zlib-fdict', unhex('7820000000015b9a919a93930f000a0b02ba'), 6],
    ['FLEVEL 2', unhex('78bb000000015b9a919a93930f000a0b02ba'), 6],
    ['a real stream with DICTID 0x12345678', fdict(real, 0x12345678), doc.length],
  ];

  test('every decoder rejects FDICT with invalid_envelope', async () => {
    for (const [label, payload, size] of payloads) {
      assert.equal((((payload[0] << 8) | payload[1]) % 31), 0, `${label}: valid FCHECK`);
      assert.ok(payload[1] & 0x20, `${label}: FDICT`);
      const env = compressionEnvelope(0, payload, size);
      for (const [name, lib] of Object.entries(builds)) {
        assert.deepEqual(await verdict(() => lib.decode(env)), { code: 'invalid_envelope' }, `${name} decode, ${label}`);
        assert.deepEqual(await verdict(() => lib.decodeAsync(env)), { code: 'invalid_envelope' }, `${name} decodeAsync, ${label}`);
        // A caller's codec that would ignore the dictionary is never asked.
        let calls = 0;
        const lax = { decompress: () => (calls++, doc) };
        assert.deepEqual(await verdict(() => lib.decode(env, { codecs: { zlib: lax } })), { code: 'invalid_envelope' });
        assert.deepEqual(await verdict(() => lib.decodeAsync(env, { codecs: { zlib: lax } })), { code: 'invalid_envelope' });
        assert.equal(calls, 0, `${name}: codec called`);
      }
      // Each decompressor rejects it on its own too: the pure-JS inflate (portable sync and
      // async) and node:zlib (Node sync, and async on the thread pool).
      for (const [which, run] of [
        ['inflateZlib', () => inflateZlib(payload, size)],
        ['portable platform', () => portablePlatform.decompress.zlib(payload, size)],
        ['node:zlib sync', () => nodePlatform.decompress.zlib(payload, size)],
        ['node:zlib async', () => nodePlatform.decompressAsync.zlib(payload, size)],
      ]) {
        assert.deepEqual(await verdict(run), { code: 'invalid_envelope' }, `${which}, ${label}`);
      }
    }
    // Without FDICT the same stream decodes.
    assert.deepEqual(node.decode(compressionEnvelope(0, real, doc.length)), { msg: 'z'.repeat(300) });
  });
});
