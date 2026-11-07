// Packaging: the exports map picks the right entry per environment, CommonJS and ESM agree,
// both entries declare the same API, and the published types compile for consumers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, builds } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function run(args, code) {
  return execFileSync(process.execPath, [...args, '--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Which entry did we get? Only the Node entry can compress synchronously without a codec.
const probe = `
  const lib = await import('@btoon/js');
  let entry;
  try { lib.encode('x'.repeat(1000), { compress: true }); entry = 'node'; }
  catch (e) { entry = e.code === 'unsupported_compression' ? 'portable' : 'error:' + e.message; }
  console.log(entry);
`;
const probeRequire = `
  import { createRequire } from 'node:module';
  const lib = createRequire(process.cwd() + '/')('@btoon/js');
  let entry;
  try { lib.encode('x'.repeat(1000), { compress: true }); entry = 'node'; }
  catch (e) { entry = e.code === 'unsupported_compression' ? 'portable' : 'error:' + e.message; }
  console.log(entry + ' ' + typeof lib.decode);
`;

test('exports map: Node gets the node entry, browser-like conditions the portable one', () => {
  assert.equal(run([], probe), 'node');
  for (const condition of ['browser', 'worker', 'workerd', 'edge-light', 'deno', 'react-native']) {
    assert.equal(run([`--conditions=${condition}`], probe), 'portable', condition);
  }
  assert.equal(run([], probeRequire), 'node function');
  assert.equal(run(['--conditions=browser'], probeRequire), 'portable function');
});

test('self-reference resolves to the same module instances the tests use', async () => {
  const self = await import('@btoon/js');
  assert.equal(self.encode, builds['esm/node'].encode);
  const require = createRequire(import.meta.url);
  assert.equal(require('@btoon/js').encode, builds['cjs/node'].encode);
});

test('package.json essentials', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.engines.node, '>=18');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'zero runtime dependencies');
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'dist/cjs/package.json'), 'utf8')).type, 'commonjs');
  for (const branch of Object.values(pkg.exports['.'])) {
    if (typeof branch === 'string') continue;
    const forms = 'import' in branch ? [branch.import, branch.require] : [branch];
    for (const f of forms) assert.ok(f.types && f.default, `every branch declares types: ${JSON.stringify(f)}`);
  }
});

test('both entries declare the same API', () => {
  const strip = (s) => s.replace(/\/\*\*[\s\S]*?@packageDocumentation\s*\*\/\s*/, '').replace(/^import .*$/gm, '').trim();
  for (const dir of ['dist/esm', 'dist/cjs']) {
    const portable = strip(readFileSync(join(ROOT, dir, 'index.d.ts'), 'utf8'));
    const node = strip(readFileSync(join(ROOT, dir, 'node.d.ts'), 'utf8'));
    assert.equal(node, portable, `${dir}: node.d.ts and index.d.ts differ`);
  }
});

test('the portable entry graph never imports node: built-ins', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(join(ROOT, 'dist/esm', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      assert.ok(!spec.startsWith('node:') && !['zlib', 'crypto', 'buffer'].includes(spec), `${file} imports ${spec}`);
      if (spec.startsWith('./')) visit(spec.slice(2));
    }
    assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bBuffer\b/, `${file} uses a Node.js global`);
  };
  visit('index.js');
  assert.ok(seen.size > 5);
});

test('published types compile for consumers (NodeNext and Bundler resolution)', () => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const project of ['tsconfig.json', 'tsconfig.bundler.json']) {
    try {
      execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'test/types', project)], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      assert.fail(`${project}:\n${e.stdout}${e.stderr}`);
    }
  }
});
