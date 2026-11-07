// Micro-benchmark: encode/decode throughput for a few document shapes, next to JSON as a
// familiar baseline. Run with `npm run bench` after `npm run build`.
//   node bench/bench.mjs [--entry=portable] [--rounds=7]
import { cpus } from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const entry = args.entry === 'portable' ? '../dist/esm/index.js' : '../dist/esm/node.js';
const { encode, decode } = await import(entry);
const ROUNDS = Number(args.rounds ?? 7);

function records(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    age: 18 + (i % 60),
    active: i % 3 !== 0,
    score: Math.round(i * 7.31) / 100,
    tags: ['alpha', i % 2 ? 'beta' : 'gamma'],
  }));
}

function nested(n) {
  return {
    service: 'billing',
    version: '2.3.1',
    nodes: Array.from({ length: n }, (_, i) => ({
      host: `node-${i}.internal`,
      up: i % 7 !== 0,
      load: [i % 4, (i * 3) % 5, (i * 7) % 9].map((x) => x / 10),
      labels: { zone: `eu-${i % 3}`, tier: i % 2 ? 'web' : 'db', [`k${i % 5}`]: i },
      events: i % 4 === 0 ? [] : [{ t: 1700000000 + i, msg: 'restart', code: i % 13 }],
    })),
  };
}

const cases = [
  ['10k records (tabular)', records(10000)],
  ['10k records, autoTabular off', records(10000), { autoTabular: false }],
  ['2k nested objects', nested(2000)],
];

function bench(fn) {
  for (let i = 0; i < 3; i++) fn(); // warm-up
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    let reps = 0;
    do {
      fn();
      reps++;
    } while (process.hrtime.bigint() - t0 < 200_000_000n);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6 / reps);
  }
  return best;
}

console.log(`node ${process.version}, ${cpus()[0]?.model ?? 'unknown CPU'}, entry ${args.entry ?? 'node'}`);
console.log('case | size | encode | decode | JSON size | JSON.stringify | JSON.parse');
for (const [name, value, opts] of cases) {
  const bytes = encode(value, opts);
  const json = JSON.stringify(value);
  const enc = bench(() => encode(value, opts));
  const dec = bench(() => decode(bytes));
  const js = bench(() => JSON.stringify(value));
  const jp = bench(() => JSON.parse(json));
  const mb = (n, ms) => `${((n / 1e6) / (ms / 1e3)).toFixed(0)} MB/s`;
  console.log(
    `${name} | ${bytes.length} B | ${enc.toFixed(2)} ms (${mb(bytes.length, enc)}) | ${dec.toFixed(2)} ms (${mb(bytes.length, dec)}) | ` +
      `${Buffer.byteLength(json)} B | ${js.toFixed(2)} ms | ${jp.toFixed(2)} ms`,
  );
}
