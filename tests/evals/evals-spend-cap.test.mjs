import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpendCap } from '../../evals/lib/spend-cap.mjs';

const RUN_EVALS = join(dirname(fileURLToPath(import.meta.url)), '../../evals/run-evals.mjs');

test('createSpendCap allows runs until the total reaches the cap, then records the stop', () => {
  const cap = createSpendCap(0.1);
  assert.strictEqual(cap.allows(), true);
  cap.add(0.06);
  assert.strictEqual(cap.allows(), true);
  assert.strictEqual(cap.stopped, false);
  cap.add(0.04);
  assert.strictEqual(cap.allows(), false);
  assert.strictEqual(cap.stopped, true);
});

test('createSpendCap with no cap never stops', () => {
  const cap = createSpendCap(undefined);
  cap.add(1000);
  assert.strictEqual(cap.limited, false);
  assert.strictEqual(cap.allows(), true);
});

// Runs `run-evals --max-total-usd 0.01 --agent implementer` against a stub `claude` on PATH
// that prints `output` on every call. Returns the exit status, the --json report and the
// number of stub calls.
function runCapped(t, output) {
  const dir = mkdtempSync(join(tmpdir(), 'spend-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\necho call >> '${calls}'\ncat <<'OUT'\n${output}\nOUT\n`);
  chmodSync(stub, 0o755);
  const report = join(dir, 'r.json');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.ANTHROPIC_API_KEY;
  delete env.EVAL_CASE_DIRS;
  const r = spawnSync('node', [RUN_EVALS, '--max-total-usd', '0.01', '--agent', 'implementer', '--json', report],
    { env, encoding: 'utf8', timeout: 30000 });
  return {
    status: r.status,
    log: r.stdout + r.stderr,
    cases: JSON.parse(readFileSync(report, 'utf8')),
    calls: readFileSync(calls, 'utf8').trim().split('\n').length,
  };
}

// The issue's verify-by, with a stub that bills $0.02 per call.
test('run-evals --max-total-usd stops after the first run, writes its report and exits 3', (t) => {
  const { status, log, cases, calls } = runCapped(t, JSON.stringify({
    is_error: false, subtype: 'success', result: JSON.stringify({ pass: true, reason: 'ok' }), total_cost_usd: 0.02,
  }));
  assert.strictEqual(status, 3, log);
  assert.strictEqual(cases.length, 1);
  assert.strictEqual(cases[0]._runs.length, 1);
  assert.strictEqual(cases[0].truncated, true);
  // One run is the agent call plus its judge call, and nothing after it.
  assert.strictEqual(calls, 2);
  assert.ok(Math.abs(cases[0].costUsd - 0.04) < 1e-9);
});

test('run-evals --max-total-usd charges an unpriced call its ceiling and stops', (t) => {
  // Output that does not parse reports no cost, like a call killed at its timeout.
  const { status, log, cases, calls } = runCapped(t, 'not json');
  assert.strictEqual(status, 3, log);
  assert.strictEqual(cases.length, 1);
  assert.strictEqual(cases[0]._runs.length, 1);
  // The agent call and its two retries, then the cap stops the sweep.
  assert.strictEqual(calls, 3);
  assert.strictEqual(cases[0].costUsd, 0);
});

test('run-evals rejects a --max-total-usd that is not a positive amount', () => {
  const r = spawnSync('node', [RUN_EVALS, '--max-total-usd', 'abc', '--agent', 'implementer'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--max-total-usd/);
});
