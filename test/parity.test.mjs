// The API parity cases (parity-cases.cjs), which the native `btoon` package runs too and must
// pass with the same outcomes: @btoon/js is the reference for both packages' behavior.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { builds } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { cases, matches, outcome } = require('./parity-cases.cjs');

const describe = (o) => JSON.stringify(o, (k, v) => (v instanceof RegExp ? String(v) : v));

for (const [name, lib] of Object.entries(builds)) {
  test(`${name}: parity cases`, () => {
    const failures = [];
    const list = cases(lib);
    assert.ok(list.length >= 100);
    for (const [caseName, fn, expected] of list) {
      const got = outcome(fn);
      if (!matches(got, expected)) failures.push(`${caseName}: expected ${describe(expected)}, got ${describe(got)}`);
    }
    assert.deepEqual(failures, []);
  });
}
