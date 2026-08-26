// run_bounded (M10): no child process a hook invokes may run, buffer, or allocate
// without an explicit ceiling on wall-clock time and output bytes, and hitting a
// ceiling must report as could-not-evaluate, never as pass or as an ordinary fail.
// These exercise the fixtures from M10-bounded-execution.md §5, plus the mapping
// onto outcome-lib.sh's (M06) could-not-evaluate exit code.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'run-bounded.sh');
const OUTCOME_LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'outcome-lib.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v timeout'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'coreutils timeout unavailable';

// Whether the timeout(1) on PATH can express "the child died of a signal" at all.
//
// GNU timeout reports a signal-killed child as 128+signal. uutils coreutils collapses that to a
// plain 1 (measured with 0.8.0; --preserve-status does not change it), and Ubuntu 25.04+ selects
// uutils through the alternatives system, so this is the default on a current Ubuntu box rather
// than an exotic setup. run_bounded reads exactly that exit code, so where timeout cannot express
// the signal, RB_STATUS comes back `ok` with RB_EXIT=1 rather than `killed`.
//
// That is a limit of the host's timeout, not of the logic under test: the same case run under GNU
// timeout reports 129 and the assertion holds. So the one case that turns on the distinction skips
// where the tool cannot make it, instead of failing every run on such a host. The consequence is
// real and worth stating plainly — on a uutils host a hook child killed by a signal is reported as
// an ordinary failure — but it is not something this suite can assert its way out of.
const signalStatusOk = toolsOk
  && spawnSync('bash', ['-c', "timeout 5 bash -c 'kill -HUP $$'"], { encoding: 'utf8' }).status === 129;
const skipSignal = skip
  || (signalStatusOk ? false : 'timeout(1) here reports signal death as exit 1, not 128+signal (uutils coreutils)');

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
