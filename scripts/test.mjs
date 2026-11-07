// Runs test/*.test.mjs with the built-in node:test runner against the built dist/.
// Arguments filter by file name: `npm test -- vectors fuzz`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../test/', import.meta.url));
if (!existsSync(fileURLToPath(new URL('../dist/esm/index.js', import.meta.url)))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}
const filters = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
  .map((f) => dir + f);
if (files.length === 0) {
  console.error(`no test files match ${filters.join(', ')}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
