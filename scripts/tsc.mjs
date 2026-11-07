// Runs the project's TypeScript compiler without relying on node_modules/.bin links
// (which some file systems, such as SMB shares, cannot hold).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const r = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
