import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, effectiveK } from '../../evals/lib/args.mjs';

test('parseArgs reads flags', () => {
  const o = parseArgs(['--agent', 'planner', '--k', '5', '--case', 'planner/001', '--json', 'out.json']);
  assert.strictEqual(o.agent, 'planner');
  assert.strictEqual(o.k, 5);
  assert.strictEqual(o.case, 'planner/001');
  assert.strictEqual(o.json, 'out.json');
  assert.strictEqual(o.smoke, false);
});

test('effectiveK precedence: smoke > --k > case k', () => {
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: true, k: 3 }), 1);
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: false, k: 3 }), 3);
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: false }), 5);
  assert.strictEqual(effectiveK({}, { smoke: false }), 1);
});
