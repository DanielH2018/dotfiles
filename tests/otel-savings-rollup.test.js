// Regression guard for home/dot_local/bin/executable_otel-savings-rollup.
// Drives the ACTUAL script against a stub otelq, so no backend is needed.
//
// The rollup exists because Loki's window is finite and a stack rebuild has
// already emptied it once. That makes its failure mode specific: a bad record
// appended today is indistinguishable from a real change a month from now, when
// the events behind it are long gone and nothing can re-derive them. So the
// tests are mostly about what it refuses to write.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run: spawnScript } = require('./lib/run');

const ROLLUP = srcPath('dot_local', 'bin', 'executable_otel-savings-rollup');

// A stub standing in for otelq: prints `out`, exits `code`.
function stub(dir, out, code = 0) {
  const p = path.join(dir, 'otelq-stub');
  fs.writeFileSync(p, `#!/usr/bin/env bash\ncat <<'STUBOUT'\n${out}\nSTUBOUT\nexit ${code}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function run(env) {
  const r = spawnScript('bash', [ROLLUP], { env: Object.assign({}, process.env, env) });
  return { code: r.code ?? 1, out: r.stdout.trim(), err: r.stderr.trim() };
}

function fixture(record, code = 0) {
  const dir = scratch(os.tmpdir(), 'rollup-');
  const out = path.join(dir, 'claude-metrics', 'daily.jsonl');
  return { dir, out, env: { XDG_DATA_HOME: dir, OTELQ: stub(dir, record, code) } };
}

// Stamped well in the past, so the same-day guard is out of the way except in
// the one test that sets out to trip it.
const GOOD = '{"report": "all", "generated_at": 1700000000, "prompts_fired": 28}';

test('appends one record and creates the directory', () => {
  const f = fixture(GOOD);
  const r = run(f.env);
  assert.strictEqual(r.code, 0, r.err);
  const lines = fs.readFileSync(f.out, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).prompts_fired, 28);
});

test('refuses to append anything that is not an "all" record', () => {
  for (const bad of ['{"report": "prompts"}', 'otelq: bad duration', '', '{"report":']) {
    const f = fixture(bad);
    const r = run(f.env);
    assert.strictEqual(r.code, 1, `should refuse: ${bad}`);
    assert.match(r.err, /unexpected output/);
    assert.ok(!fs.existsSync(f.out),
      'a half-record is worse than a gap — the gap is visible in the trend');
  }
});

test('writes nothing when the query itself fails', () => {
  const f = fixture('otelq: 127.0.0.1:3100 unreachable', 2);
  const r = run(f.env);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /query failed/);
  assert.ok(!fs.existsSync(f.out));
});

test('reports a missing otelq rather than silently doing nothing', () => {
  const dir = scratch(os.tmpdir(), 'rollup-');
  const r = run({ XDG_DATA_HOME: dir, OTELQ: 'otelq-that-does-not-exist' });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /not on PATH/);
});

// Persistent=true means a run missed to a powered-down evening fires on the next
// boot, which can be hours after the scheduled one. Two records covering one day
// plot as a real movement rather than as a repeat.
test('skips a second run on the same day', () => {
  const f = fixture(`{"report": "all", "generated_at": ${Math.floor(Date.now() / 1000)}}`);
  assert.strictEqual(run(f.env).code, 0);
  const second = run(f.env);
  assert.strictEqual(second.code, 0, 'a skip is success, not failure');
  assert.match(second.out, /skipping/);
  assert.strictEqual(fs.readFileSync(f.out, 'utf8').trim().split('\n').length, 1);
});

test('appends again once the gap is wide enough', () => {
  const f = fixture(GOOD); // stamped in the past, so the guard should not fire
  assert.strictEqual(run(f.env).code, 0);
  assert.strictEqual(run(f.env).code, 0);
  assert.strictEqual(fs.readFileSync(f.out, 'utf8').trim().split('\n').length, 2);
});

