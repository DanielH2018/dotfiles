// run_bounded (M10): no child process a hook invokes may run, buffer, or allocate
// without an explicit ceiling on wall-clock time and output bytes, and hitting a
// ceiling must report as could-not-evaluate, never as pass or as an ordinary fail.
// These exercise the fixtures from M10-bounded-execution.md §5, plus the mapping
// onto outcome-lib.sh's (M06) could-not-evaluate exit code.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { skipUnless } = require('../lib/probe');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'run-bounded.sh');
const OUTCOME_LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'outcome-lib.sh');

const skip = skipUnless('bash', 'timeout');

// The preference list run-bounded.sh resolves RB_TIMEOUT from, mirrored here so the tests can
// answer the same question the library does.
const TIMEOUT_NAMES = ['gtimeout', 'gnutimeout', 'timeout'];
const firstPresent = TIMEOUT_NAMES.find(
  (c) => spawnSync('bash', ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0,
);

// Whether the timeout run_bounded actually drives can express "the child died of a signal".
//
// GNU reports a signal-killed child as 128+signal; uutils coreutils collapses it to a plain 1,
// and --preserve-status does not change it. run_bounded reads that code, so under uutils a
// crashing child reads as an ordinary failure instead of `killed` — the exact misread the status
// exists to prevent. Resolving to a GNU build is what fixes it, so the question is about the
// resolved binary, not about whatever `timeout` happens to name.
//
// Where no GNU timeout is installed at all there is nothing to resolve to, so the one case that
// turns on the distinction skips — with a reason that names the fix rather than restating the
// defect. Every other bound still holds there; `killed` is the single casualty.
//
// Read off stdout rather than the child's own status: when the signalled command is the last one
// a shell runs, bash reports it by killing ITSELF with the same signal, so spawnSync comes back
// status=null/signal=SIGHUP and the 129 never surfaces. Trailing the printf keeps the exit code a
// number. run_bounded is unaffected — it reads ${PIPESTATUS[0]} mid-script, never as a tail call.
const signalStatusOk = !!firstPresent
  && spawnSync('bash', ['-c', `${firstPresent} 5 bash -c 'kill -HUP $$'; printf %s "$?"`],
    { encoding: 'utf8' }).stdout.trim() === '129';
const skipSignal = skip
  || (signalStatusOk ? false
    : 'no GNU timeout(1) on this host — install coreutils (macOS) or gnu-coreutils (Ubuntu) so signal deaths can be classified');

// Run a snippet with run_bounded (and optionally outcome-lib) sourced, then print
// the RB_* out-params as a parseable line so the test can assert on them.
function sh(snippet, { withOutcomeLib = false, timeoutMs = 15000 } = {}) {
  const src = withOutcomeLib
    ? `. ${JSON.stringify(LIB)}; . ${JSON.stringify(OUTCOME_LIB)}; ${snippet}`
    : `. ${JSON.stringify(LIB)}; ${snippet}`;
  const r = spawnSync('bash', ['-c', src], { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function rb(cmd, { extra = '' } = {}) {
  const r = sh(`${cmd}; printf 'STATUS=%s\\nEXIT=%s\\nSIGNAL=%s\\nOUT=%s\\n' "$RB_STATUS" "$RB_EXIT" "$RB_SIGNAL" "$RB_OUT"; ${extra}`);
  const out = {};
  for (const m of r.stdout.matchAll(/^(STATUS|EXIT|SIGNAL|OUT)=(.*)$/gm)) out[m[1]] = m[2];
  return { ...r, rb: out };
}

// The resolution itself, asserted independently of which binaries this host happens to carry.
// A bare `timeout` here is what made a crashing hook child read as an ordinary failure on Ubuntu,
// so the preference list being reordered or dropped is a regression worth catching directly
// rather than only through the signal case below, which skips where no GNU build exists.
test('the timeout binary is resolved by preference, and RB_TIMEOUT overrides it', { skip }, () => {
  const sourced = (prefix) => spawnSync('bash', ['-c',
    `${prefix}; . ${JSON.stringify(LIB)}; printf '%s' "$RB_TIMEOUT"`], { encoding: 'utf8' }).stdout;
  assert.strictEqual(sourced('unset RB_TIMEOUT'), firstPresent,
    'run_bounded must drive the first preferred timeout present on this host');
  assert.strictEqual(sourced('export RB_TIMEOUT=/custom/tmo'), '/custom/tmo',
    'an explicit RB_TIMEOUT must win, so a caller can pin either implementation');
});

test('normal completion: exit 0 inside the bound is status ok', { skip }, () => {
  const { rb: out } = rb(`run_bounded 5 4096 -- echo hello`);
  assert.strictEqual(out.STATUS, 'ok');
  assert.strictEqual(out.EXIT, '0');
  assert.match(out.OUT, /hello/);
});

test('a real non-zero exit inside the bound is status ok, not could-not-evaluate', { skip }, () => {
  const { rb: out } = rb(`run_bounded 5 4096 -- bash -c 'exit 7'`);
  assert.strictEqual(out.STATUS, 'ok', 'a real verdict from the command must not be reclassified');
  assert.strictEqual(out.EXIT, '7');
});

test('timeout, child honors TERM: killed at the wall-clock ceiling', { skip }, () => {
  const start = Date.now();
  // Fractional: the timeout is handed straight to `timeout`, which takes it. A whole second
  // here bought nothing -- the assertion is that TERM lands first, not that it lands at 1s.
  const { rb: out } = rb(`run_bounded 0.2 4096 -- sleep 999`);
  const elapsed = Date.now() - start;
  assert.strictEqual(out.STATUS, 'timeout');
  assert.ok(elapsed < 1500, `should die on TERM well before the 2s kill-after grace, took ${elapsed}ms`);
});

test('timeout, child ignores TERM: escalates to SIGKILL after kill-after', { skip }, () => {
  const start = Date.now();
  const { rb: out } = rb(`run_bounded 0.2 4096 -- bash -c 'trap "" TERM; sleep 999'`, { extra: '' });
  const elapsed = Date.now() - start;
  assert.strictEqual(out.STATUS, 'timeout', 'kill-after must still resolve this to timeout, not hang forever');
  // The 2s grace dominates and is not a parameter, so this is the floor for the escalation
  // path. Staying past 1s is what proves TERM was ignored and SIGKILL did the work: a child
  // that honoured TERM would have been gone at 0.2s.
  assert.ok(elapsed >= 1000 && elapsed < 6000, `expected ~2.2s (0.2s TERM + up to 2s kill-after), took ${elapsed}ms`);
});

test('flooded stdout is truncated at the byte cap, not buffered whole first', { skip }, () => {
  const { rb: out } = rb(`run_bounded 5 100 -- bash -c "head -c 2000000 /dev/zero | tr '\\0' 'x'; exit 0"`);
  assert.strictEqual(out.STATUS, 'truncated');
  assert.strictEqual(out.OUT.length, 100, 'captured output must be capped at exactly max_bytes');
});

// SIGHUP, not SIGSEGV: a self-inflicted SEGV is a core-dumping signal, so every run of
// this suite handed systemd-coredump a real crash and KDE's drkonqi popped a "bash closed
// unexpectedly" notification on the desktop. `ulimit -c 0` only suppresses the core *file* —
// the coredump handler still runs and still notifies. SIGHUP terminates without dumping,
// is 1 on both Linux and macOS (unlike SIGUSR1, which is 10 vs 30), and stays distinct from
// the timeout path's TERM-then-KILL, which is the whole point of this test.
test('killed by its own signal is distinct from a timeout kill', { skip: skipSignal }, () => {
  const { rb: out } = rb(`run_bounded 5 4096 -- bash -c 'kill -HUP $$'`);
  assert.strictEqual(out.STATUS, 'killed', 'a self-inflicted signal must not be misread as a timeout');
  assert.strictEqual(out.SIGNAL, '1', 'SIGHUP is signal 1');
  assert.strictEqual(out.EXIT, '129', '128 + 1');
});

test('the could-not-evaluate mapping onto outcome-lib: any non-ok status feeds oc_cannot to exit 3', { skip }, () => {
  // Reference mapping for consumers that want a hard could-not-evaluate exit
  // (distinct from lint-after-edit.sh's own choice — see its run_check comment
  // — which uses oc_mark instead so a timeout doesn't abort before the hook's
  // JSON block reason is emitted). This proves the contract: run_bounded's
  // non-ok statuses are exactly M06's could-not-evaluate bucket.
  const r = sh(
    `run_bounded 1 4096 -- sleep 999
     [ "$RB_STATUS" = ok ] || oc_cannot lint-x "run_bounded: $RB_STATUS"`,
    { withOutcomeLib: true },
  );
  assert.strictEqual(r.status, 3, 'could-not-evaluate must reach the M06 exit-3 convention, not 0/1');
  assert.match(r.stderr, /CANNOT-EVALUATE \[lint-x\]/);
});

test('a genuinely passing run never reaches could-not-evaluate', { skip }, () => {
  const r = sh(
    `run_bounded 5 4096 -- true
     [ "$RB_STATUS" = ok ] || oc_cannot lint-x "run_bounded: $RB_STATUS"
     printf 'reached\\n'`,
    { withOutcomeLib: true },
  );
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /reached/);
});
