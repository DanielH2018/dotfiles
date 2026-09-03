const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../bin/shadow-report-lib.js');

const BIN = path.join(__dirname, '..', 'bin', 'shadow-report');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-report-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A small, self-contained stand-in for block-dangerous-bash.sh's M02 section — just enough
// structure for censusFamiliesFromSource / denyRuleLabelsFromSource to have something real
// to parse, without dragging the 500-line real file into every test.
const FIXTURE_HOOK = `
deny() { :; }
if bdb_rei "\$segscan" "\$SSH_AT_RE" && ! bdb_rei "\$SCAN" "\$SSH_AT_RE"; then
  case \$newly in *ssh*) ;; *) newly="\$newly ssh" ;; esac
fi
if bdb_rei "\$segscan" "\$TF_RE" && ! bdb_rei "\$SCAN" "\$TF_RE"; then
  case \$newly in *terraform*) ;; *) newly="\$newly terraform" ;; esac
fi
if bdb_re "\$SCAN" "\$RM_TARGET"; then
  deny "Blocked: rm -rf targeting home or root directory. Use a specific path instead."
fi
if bdb_re "\$SCAN" "\$RM_TARGET2"; then
  deny "Blocked: rm -rf targeting home or root directory. Use a specific path instead."
fi
if bdb_re "\$SCAN" "\$FORCE_PUSH"; then
  deny "Blocked: force-push to main/master. Use a feature branch."
fi
`;

// A hook source missing the terraform census family entirely — the input the non-vacuity
// guard (MIN_KNOWN_CENSUS_FAMILIES) must reject rather than silently report as complete.
const FIXTURE_HOOK_MISSING_TERRAFORM = `
if bdb_rei "\$segscan" "\$SSH_AT_RE"; then
  case \$newly in *ssh*) ;; *) newly="\$newly ssh" ;; esac
fi
`;

function writeFixture(name, text) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

// --- lib.parseLines --------------------------------------------------------------------

test('parseLines parses valid JSONL and reports malformed lines without dropping them silently', () => {
  const text = '{"a":1}\n{"a":2}\n\nnot json\n{"a":3}\n';
  const { rows, errors } = lib.parseLines(text);
  assert.deepStrictEqual(rows, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].lineNo, 4);
});

// --- lib.censusFamiliesFromSource -------------------------------------------------------

test('censusFamiliesFromSource extracts family names from the case-arm literals', () => {
  assert.deepStrictEqual(lib.censusFamiliesFromSource(FIXTURE_HOOK), ['ssh', 'terraform']);
});

// --- lib.denyRuleLabelsFromSource -------------------------------------------------------

test('denyRuleLabelsFromSource extracts and dedupes deny() reason labels', () => {
  const labels = lib.denyRuleLabelsFromSource(FIXTURE_HOOK);
  // Two deny() sites share the same message (the two rm -rf forms of one rule) — that must
  // collapse to one label, not two, or the report would double-count a single rule.
  assert.deepStrictEqual(labels, [
    'force-push to main/master',
    'rm -rf targeting home or root directory',
  ]);
});

// --- lib.summarize: the red-proof pair ---------------------------------------------------
//
// One family that fired, one that never did, in the SAME window — a report that can't tell
// them apart is worthless for a delete pass.

test('summarize: a family with a logged hit reports fired=true and the right counts', () => {
  const rows = [
    { ts: 't1', status: 'ok', old: 'none', newly_anchored: ['ssh'] },
    { ts: 't2', status: 'ok', old: 'none', newly_anchored: null },
  ];
  const s = lib.summarize(rows, ['ssh', 'terraform']);
  const ssh = s.families.find((f) => f.family === 'ssh');
  assert.strictEqual(ssh.fired, true);
  assert.strictEqual(ssh.newly_anchored, 1);
  assert.strictEqual(s.disagreements.length, 1);
  assert.strictEqual(s.disagreements[0].family, 'ssh');
});

test('summarize: a census family with zero rows over the window reports fired=false, not omitted', () => {
  const rows = [
    { ts: 't1', status: 'ok', old: 'none', newly_anchored: ['ssh'] },
  ];
  const s = lib.summarize(rows, ['ssh', 'terraform']);
  const tf = s.families.find((f) => f.family === 'terraform');
  assert.ok(tf, 'terraform must still appear in the report even with zero hits');
  assert.strictEqual(tf.fired, false);
  assert.strictEqual(tf.newly_anchored, 0);
  assert.strictEqual(tf.newly_anchored_sub, 0);
  assert.strictEqual(tf.sub_anchored, 0);
});

test('summarize: sub_anchored alone (no newly_anchored_sub) counts toward fired but is not a disagreement', () => {
  const rows = [{ ts: 't1', status: 'ok', old: 'deny', sub_anchored: ['ssh'] }];
  const s = lib.summarize(rows, ['ssh']);
  const ssh = s.families.find((f) => f.family === 'ssh');
  assert.strictEqual(ssh.fired, true);
  assert.strictEqual(ssh.sub_anchored, 1);
  assert.strictEqual(s.disagreements.length, 0, 'sub_anchored without newly_anchored_sub is SCAN already catching it — not a gap');
});

// --- End-to-end over a small fixture log/hook (never the real 2.7MB log) ----------------

test('bin/shadow-report reports FIRED/NEVER FIRED correctly over a fixture log+hook', () => {
  const hookPath = writeFixture('hook.sh', FIXTURE_HOOK);
  const logPath = writeFixture('log.jsonl', [
    JSON.stringify({
      ts: '2026-01-01T00:00:00Z', hook: 'block-dangerous-bash', cmd: 'ssh h reboot',
      old: 'none', status: 'ok', nseg: 1, nsubseg: 0,
      newly_anchored: ['ssh'], newly_anchored_sub: null, sub_anchored: null,
    }),
    JSON.stringify({
      ts: '2026-01-01T00:01:00Z', hook: 'block-dangerous-bash', cmd: 'echo hi',
      old: 'none', status: 'ok', nseg: 1, nsubseg: 0,
      newly_anchored: null, newly_anchored_sub: null, sub_anchored: null,
    }),
  ].join('\n') + '\n');

  const out = execFileSync('node', [BIN, '--log', logPath, '--hook', hookPath], { encoding: 'utf8' });
  assert.match(out, /FIRED\s+ssh/);
  assert.match(out, /NEVER FIRED\s+terraform/);
  assert.match(out, /delete-pass candidates \(never fired over this window\): terraform/);
  assert.match(out, /2 rows/);
});

test('bin/shadow-report --json reports the same data in machine-readable form', () => {
  const hookPath = writeFixture('hook-json.sh', FIXTURE_HOOK);
  const logPath = writeFixture('log-json.jsonl', JSON.stringify({
    ts: '2026-01-01T00:00:00Z', old: 'none', status: 'ok',
    newly_anchored: ['terraform'], newly_anchored_sub: null, sub_anchored: null,
  }) + '\n');

  const out = execFileSync('node', [BIN, '--log', logPath, '--hook', hookPath, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.summary.totalRows, 1);
  const tf = parsed.summary.families.find((f) => f.family === 'terraform');
  const ssh = parsed.summary.families.find((f) => f.family === 'ssh');
  assert.strictEqual(tf.fired, true);
  assert.strictEqual(ssh.fired, false);
});

test('bin/shadow-report handles a missing log file as zero rows, not a crash', () => {
  const hookPath = writeFixture('hook-nolog.sh', FIXTURE_HOOK);
  const out = execFileSync('node', [BIN, '--log', path.join(tmp, 'does-not-exist.jsonl'), '--hook', hookPath], { encoding: 'utf8' });
  assert.match(out, /log file does not exist yet/);
});

// The non-vacuity guard: a hook source whose family-extraction regex found fewer than the
// known-minimum set must fail loudly, not silently report an incomplete family list as if
// it were the whole census.
test('bin/shadow-report refuses to run against a hook source missing a known census family', () => {
  const hookPath = writeFixture('hook-missing.sh', FIXTURE_HOOK_MISSING_TERRAFORM);
  const logPath = writeFixture('log-missing.jsonl', '');
  assert.throws(() => {
    execFileSync('node', [BIN, '--log', logPath, '--hook', hookPath], { encoding: 'utf8', stdio: 'pipe' });
  }, (err) => {
    assert.strictEqual(err.status, 2);
    assert.match(err.stderr.toString(), /expected census family "terraform" not found/);
    return true;
  });
});

// --- Guard the real hook source doesn't silently drop below the known minimum ----------

test('the real block-dangerous-bash.sh source still names both known census families', () => {
  const realHook = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_block-dangerous-bash.sh');
  const src = fs.readFileSync(realHook, 'utf8');
  const families = lib.censusFamiliesFromSource(src);
  for (const known of lib.MIN_KNOWN_CENSUS_FAMILIES) {
    assert.ok(families.includes(known), `${known} missing from the real hook's extracted family list`);
  }
});
