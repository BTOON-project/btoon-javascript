// Copies the conformance vectors from btoon-core into test/vectors/ (never edit the copy by
// hand). Source: the path given as an argument, or a sibling ../btoon-core checkout.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.argv[2],
  join(root, '../btoon-core/tests/vectors/btoon-vectors.json'),
].filter(Boolean);
const source = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
if (!source) {
  console.error(`btoon-vectors.json not found; tried:\n  ${candidates.join('\n  ')}`);
  process.exit(1);
}
const target = join(root, 'test/vectors/btoon-vectors.json');
copyFileSync(source, target);
const doc = JSON.parse(readFileSync(target, 'utf8'));
console.log(`copied ${doc.vectors.length} vectors (spec ${doc.spec}) from ${source}`);
