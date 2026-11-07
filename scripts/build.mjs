// Builds dist/esm (ES modules) and dist/cjs (CommonJS), each with .d.ts files, using tsc.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const project of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit', cwd: root });
}
// dist/cjs holds CommonJS .js files inside a "type": "module" package.
writeFileSync(join(root, 'dist/cjs/package.json'), '{\n  "type": "commonjs"\n}\n');

// The portable entry must never reach a node: built-in.
const esm = join(root, 'dist/esm');
const seen = new Set();
const visit = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(join(esm, file), 'utf8');
  for (const [, spec] of src.matchAll(/from\s+'([^']+)'/g)) {
    if (spec.startsWith('node:')) throw new Error(`portable entry imports ${spec} (via ${file})`);
    if (spec.startsWith('./')) visit(spec.slice(2));
  }
};
visit('index.js');
const files = readdirSync(esm).filter((f) => f.endsWith('.js'));
console.log(`built dist/esm and dist/cjs (${files.length} modules; portable entry graph: ${seen.size} modules, no node: imports)`);
