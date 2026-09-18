// outcome-lib.sh: could-not-evaluate has to be a state of its own, recorded and
// visible, never collapsed into a pass. These assert the three exits, the marker
// accumulating per id, the jq-free recorder, and the UNEVAL_GATE=warn rollback.
//
// No consumer is wired to this library yet — that is deliberate, so shipping it cannot
// change any existing gate's behaviour.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'outcome-lib.sh');

const skip = skipUnless('bash', 'jq');

function markerDir() {
  const d = scratch(os.tmpdir(), 'outcome-');
  return d;
}

// Run a snippet with the lib sourced. spawnSync rather than execFileSync because a
// demoted could-not-evaluate exits 0 while still writing to stderr, and execFileSync
// only surfaces stderr when the command fails.
function sh(dir, snippet, env = {}) {
  const script = `set -u; . ${JSON.stringify(LIB)}; ${snippet}`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, OUTCOME_MARKER_DIR: dir, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const marker = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));

test('oc_pass exits 0 and records nothing', { skip }, () => {
  const d = markerDir();
  assert.strictEqual(sh(d, 'oc_pass').status, 0);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('oc_fail exits 1 — a verdict was reached and it was negative', { skip }, () => {
  const d = markerDir();
  const r = sh(d, 'oc_fail sig-check "two unsigned commits"');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^FAIL \[sig-check\]/m);
  assert.strictEqual(marker(d, 'sig-check').state, 'fail');
});

test('oc_cannot exits 3 — distinct from both pass and fail', { skip }, () => {
  const d = markerDir();
  const r = sh(d, 'oc_cannot sig-range "git log could not resolve the range"');
  assert.strictEqual(r.status, 3, 'could-not-evaluate must not share an exit code with either verdict');
  assert.match(r.stderr, /^CANNOT-EVALUATE \[sig-range\]/m);
  const m = marker(d, 'sig-range');
  assert.strictEqual(m.state, 'cannot');
  assert.match(m.reason, /could not resolve/);
});

test('repeats accumulate into one marker rather than a pile of files', { skip }, () => {
  const d = markerDir();
  for (let i = 0; i < 3; i++) sh(d, 'oc_mark reaper-loop cannot "no procStart"');
  assert.deepStrictEqual(fs.readdirSync(d), ['reaper-loop.json']);
  const m = marker(d, 'reaper-loop');
  assert.strictEqual(m.n, 3, 'frequency is kept; a 35s loop must not create 2000 files');
  assert.ok(m.first <= m.last);
});

test('the recorder does not need jq — jq being broken is a thing it reports', { skip }, () => {
  const d = markerDir();
  // A PATH with coreutils but no jq: the marker must still land, because "jq is
  // missing" is precisely one of the conditions this store exists to record.
  const bin = scratch(os.tmpdir(), 'nojq-');
  for (const t of ['bash', 'mkdir', 'date', 'sed', 'mv', 'rm', 'head', 'cat']) {
    const real = spawnSync('command', ['-v', t], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(bin, t));
  }
  const r = sh(d, 'oc_mark no-jq cannot "probe"; printf done', { PATH: bin });
  assert.strictEqual(spawnSync('bash', ['-c', 'command -v jq'], { env: { PATH: bin } }).status, 1,
    'the fixture PATH really has no jq');
  assert.match(r.stdout, /done/);
  assert.strictEqual(marker(d, 'no-jq').state, 'cannot');
});

test('UNEVAL_GATE=warn demotes the block but keeps the marker', { skip }, () => {
  const d = markerDir();
  const r = sh(d, 'oc_cannot shim-missing "hook not executable"; printf continued', { UNEVAL_GATE: 'warn' });
  assert.strictEqual(r.status, 0, 'the rollback lever must not block');
  assert.match(r.stdout, /continued/);
  assert.match(r.stderr, /CANNOT-EVALUATE/, 'demoted, not silenced');
  assert.strictEqual(marker(d, 'shim-missing').n, 1);
});

test('oc_need reports a missing tool instead of shrugging', { skip }, () => {
  const d = markerDir();
  assert.strictEqual(sh(d, 'oc_need bash have-bash').status, 0);
  const r = sh(d, 'oc_need definitely-not-a-real-binary need-x');
  assert.strictEqual(r.status, 3);
  assert.match(marker(d, 'need-x').reason, /not on PATH/);
});

test('oc_json separates an empty answer from a broken jq', { skip }, () => {
  const d = markerDir();
  const empty = sh(d, `printf '{}' | oc_json '.missing // ""' jq-a`);
  assert.strictEqual(empty.status, 0, 'an empty result is a real answer');
  assert.strictEqual(empty.stdout, '');
  const broken = sh(d, `printf 'not json' | oc_json '.x' jq-b`);
  assert.strictEqual(broken.status, 3, 'a parse failure is could-not-evaluate, not an empty answer');
});

test('oc_run turns a failed prerequisite into could-not-evaluate', { skip }, () => {
  const d = markerDir();
  assert.strictEqual(sh(d, 'oc_run r1 "probe failed" -- true').status, 0);
  assert.strictEqual(sh(d, 'oc_run r2 "probe failed" -- false').status, 3);
});

test('uneval counts, lists and acks', { skip }, () => {
  const d = markerDir();
  sh(d, 'oc_mark a cannot x; oc_mark b cannot y');
  assert.strictEqual(sh(d, 'uneval count').stdout.trim(), '2');
  assert.match(sh(d, 'uneval list').stdout, /"id":"a"/);
  sh(d, 'uneval ack a');
  assert.strictEqual(sh(d, 'uneval count').stdout.trim(), '1');
});

test('an id that is not filename-safe is refused, not written', { skip }, () => {
  const d = markerDir();
  sh(d, 'oc_mark "../escape" cannot x');
  assert.deepStrictEqual(fs.readdirSync(d), [], 'a caller must not be able to aim the write');
});

test('no helper can produce exit 2, which would discard a user prompt', { skip }, () => {
  const src = fs.readFileSync(LIB, 'utf8');
  assert.doesNotMatch(src, /exit 2\b/, 'exit 2 on a UserPromptSubmit hook drops the prompt');
});
