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


// --- The figures the prose quotes -------------------------------------------------------
//
// CLAUDE.md.tmpl's jsonq paragraph quotes what `otelq savings reduction` and `otelq savings
// bytes` printed once. Nothing tied the sentence to the tool, so the numbers dated the
// paragraph and drifted: the literals it carried until 2026-09-23 were 97.4 MB read across
// 223 calls at 3,616:1, and the same query that week returned 8.4 MB across 534 calls at
// 87.9:1 (#578). tests/fixtures/otel-savings.json is the snapshot the paragraph is now
// written from, and this formats the fixture's fields and asserts each literal is in the
// paragraph -- so a hand-edited number, or a refreshed fixture the prose was not rewritten
// for, fails here instead of quietly misinforming the next reader.
//
// Deliberately not a rerun with a tolerance band. Both windows are rolling 7-day windows over
// this machine's own telemetry, the bytes half needs Loki reachable, and a check that reruns
// them is red on any quiet week and unrunnable in CI. A snapshot is a fact with a date on it.
const { repoPath } = require('./lib/paths');

const FIXTURE = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'otel-savings.json'), 'utf8'));
const CLAUDE_MD = srcPath('private_dot_claude', 'CLAUDE.md.tmpl');
const OTELQ = srcPath('dot_local', 'bin', 'executable_otelq');

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const kb = (bytes) => `${(bytes / 1e3).toFixed(1)} KB`;

// Each entry is one literal the paragraph must carry, named by the field it comes from.
function quotedFigures(fixture) {
  const r = fixture.reduction;
  return [
    ['measured', fixture.measured],
    ['reduction.bytes_in', mb(r.bytes_in)],
    ['reduction.bytes_out', kb(r.bytes_out)],
    ['reduction.calls', `${r.calls} calls`],
    ['reduction.reduction_ratio', `${r.reduction_ratio}:1`],
    ['reduction.median_call_ratio', `median ${r.median_call_ratio}:1`],
    ['bytes.bytes_total', mb(fixture.bytes.bytes_total)],
  ];
}

function missingFigures(prose, fixture) {
  return quotedFigures(fixture)
    .filter(([, literal]) => !prose.includes(literal))
    .map(([field, literal]) => `${field}: ${literal}`);
}

test('the jsonq paragraph in CLAUDE.md.tmpl still matches the snapshot it was written from', () => {
  const prose = fs.readFileSync(CLAUDE_MD, 'utf8');
  assert.deepStrictEqual(missingFigures(prose, FIXTURE), []);
});

test('a hand-edited literal in that paragraph is caught', () => {
  const prose = fs.readFileSync(CLAUDE_MD, 'utf8').replace(mb(FIXTURE.reduction.bytes_in), '9.9 MB');
  // Built from the fixture rather than restated: refreshing the snapshot is the documented
  // way to move these figures, and a literal here would make that refresh red for no reason.
  assert.deepStrictEqual(missingFigures(prose, FIXTURE),
    [`reduction.bytes_in: ${mb(FIXTURE.reduction.bytes_in)}`]);
});

// The fixture is only as good as the field names it copies. otelq is where they are produced,
// so a rename there -- which would make the next snapshot a different shape -- goes red here
// rather than at the next refresh.
test('every field the fixture quotes is one otelq still emits', () => {
  const src = fs.readFileSync(OTELQ, 'utf8');
  const fields = ['bytes_in', 'bytes_out', 'calls', 'reduction_ratio', 'median_call_ratio', 'bytes_total'];
  const gone = fields.filter((f) => !src.includes(`"${f}"`));
  assert.deepStrictEqual(gone, []);
  // The snapshot is worthless if jsonq rotated its counter mid-window; the rollup says so.
  assert.strictEqual(FIXTURE.reduction.truncated, false);
});
