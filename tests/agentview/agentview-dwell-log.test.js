// Slice 1b instrumentation: does a remote row ever change while a picker is open?
//
// refresh_one_remote rewrites a host's cache on every successful fetch whether or not anything
// changed, so the fingerprint is over CONTENT rather than stat -- see av_remote_fingerprint.
// Dwell time alone would not answer the question: a picker open for ten minutes during which
// nothing remote moved argues against streaming just as strongly as one open for five seconds.
//
// The comparison baseline is the snapshot as it stood once the STARTUP refresh settled, not as
// it stood at picker open. The startup refresh is detached, so an open-time baseline is taken
// mid-fetch and turns "the remote moved since you last looked" into "a row moved while you
// watched" -- a different question, and the wrong one for deciding whether to push.
//
// Sources the libs directly and never runs the launcher, which is what exempts this suite from
// the agentview-seams rule -- the same property agentview-seen-state.test.js relies on.
//
// TEMPORARY: delete this file with the functions it covers once the push-vs-poll decision lands.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A frozen clock, and the one reason this file needs one. av_log_dwell reads `date +%s` for
// `now` and subtracts the open timestamp the fixture captured -- two clock reads a fork apart,
// so a second boundary landing between them logs 43 where the fixture meant 42. That is how the
// duration test below failed a land while passing every time in isolation: under parallel load
// the gap between the two forks widens until it straddles a tick. Shadowing `date` on PATH is
// the same technique this suite's siblings use for ssh and mv, and it only freezes `+%s` --
// anything else is handed to the real date, so the stub can't quietly answer a question nobody
// asked it. The fixtures name CLOCK as a literal rather than reading the stub back through
// `date`, so if the stub ever falls off PATH the duration test fails loudly on a nine-digit
// number instead of going flaky again.
const CLOCK = 1700000000;
const clockBin = scratch('dwell-clock-');
fs.writeFileSync(path.join(clockBin, 'date'),
  `#!/bin/bash\n[ "$1" = '+%s' ] && { printf '%s\\n' ${CLOCK}; exit 0; }\ncommand -p date "$@"\n`,
  { mode: 0o755 });

// Drives the two functions against a scratch HOME holding the given per-host caches. `after`
// runs between the open-time capture and the close-time log, standing in for whatever happened
// while the picker was up.
function drive(caches, after = () => {}) {
  const home = scratch('dwell-');
  for (const [host, body] of Object.entries(caches)) {
    fs.writeFileSync(path.join(home, `.agentview-remote-cache.${host}`), body);
  }
  const stamp = path.join(home, 'stamp');
  const preamble = `
    set -u
    US=$'\\037'
    export HOME=${JSON.stringify(home)}
    export PATH=${JSON.stringify(clockBin)}:$PATH
    declare -A HOST_SSH=( [alpha]="alpha" [beta]="beta" )
    source ${JSON.stringify(LIB)}/common.sh
  `;

  execFileSync('bash', ['-c', `${preamble}
    av_remote_fingerprint
    printf '%s' "$_av_fp" > ${JSON.stringify(stamp)}
  `], { encoding: 'utf8' });

  after(home);

  execFileSync('bash', ['-c', `${preamble}
    _av_fp_open=$(cat ${JSON.stringify(stamp)})
    _av_open_ts=${CLOCK - 42}
    av_log_dwell
  `], { encoding: 'utf8' });

  const log = path.join(home, '.claude', 'agent-view-dwell.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\t') : null;
}

// The real sequence, which `drive` above cannot express: the picker captures an open-time
// fingerprint, THEN the detached startup refresh lands and writes the settled baseline, and
// only what moves after that counts. Each argument is the full set of caches at that point.
function driveSettled(atOpen, atSettled, atClose, { writeBaseline = true } = {}) {
  const home = scratch('dwell-settled-');
  const portfile = path.join(home, 'port');
  const stamp = path.join(home, 'stamp');
  const write = (caches) => {
    for (const [host, body] of Object.entries(caches)) {
      fs.writeFileSync(path.join(home, `.agentview-remote-cache.${host}`), body);
    }
  };
  const preamble = `
    set -u
    US=$'\\037'
    export HOME=${JSON.stringify(home)}
    export PATH=${JSON.stringify(clockBin)}:$PATH
    declare -A HOST_SSH=( [alpha]="alpha" [beta]="beta" )
    source ${JSON.stringify(LIB)}/common.sh
  `;

  write(atOpen);
  execFileSync('bash', ['-c', `${preamble}
    av_remote_fingerprint
    printf '%s' "$_av_fp" > ${JSON.stringify(stamp)}
  `], { encoding: 'utf8' });

  write(atSettled);
  if (writeBaseline) {
    execFileSync('bash', ['-c', `${preamble}
      av_write_dwell_baseline ${JSON.stringify(portfile)}
    `], { encoding: 'utf8' });
  }

  write(atClose);
  execFileSync('bash', ['-c', `${preamble}
    _av_fp_open=$(cat ${JSON.stringify(stamp)})
    _av_open_ts=${CLOCK - 42}
    av_log_dwell ${JSON.stringify(portfile)}
  `], { encoding: 'utf8' });

  const log = path.join(home, '.claude', 'agent-view-dwell.log');
  const row = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\t') : null;
  return { row, baselineLeft: fs.existsSync(`${portfile}.fp`) };
}

test('an unchanged remote cache logs no change', () => {
  const row = drive({ alpha: 'a\n', beta: 'b\n' });
  assert.ok(row, 'a line must be written even when nothing changed -- that is the negative result');
  assert.strictEqual(row[2], 'no');
});

test('a rewritten remote cache logs a change', () => {
  // The case streaming would exist for: a remote row moved while the operator sat on the picker.
  const row = drive({ alpha: 'a\n', beta: 'b\n' }, (home) => {
    fs.writeFileSync(path.join(home, '.agentview-remote-cache.alpha'), 'a-changed-and-longer\n');
  });
  assert.strictEqual(row[2], 'yes');
});

test('a cache rewritten with identical content is not a change', () => {
  // The bug this exists to prevent, found by running the real picker: refresh_one_remote
  // replaces the cache with `mv -f` on EVERY successful fetch, changed or not, and the picker
  // fires a refresh at startup. A stat-based fingerprint therefore reported "yes" for
  // essentially every picker -- inventing the exact answer the measurement is meant to decide.
  const row = drive({ alpha: 'a\n', beta: 'b\n' }, (home) => {
    const p = path.join(home, '.agentview-remote-cache.alpha');
    fs.rmSync(p);
    fs.writeFileSync(p, 'a\n');   // same bytes, fresh inode -- what mv -f leaves behind
    // Move the mtime explicitly. Rewriting inside the same wall-clock second leaves stat's
    // second-resolution %Y untouched, which would let a stat-based fingerprint pass this test
    // for the wrong reason -- the first version of it did exactly that.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(p, future, future);
  });
  assert.strictEqual(row[2], 'no', 'identical content through a fresh inode is not a row change');
});

test('the open duration is recorded', () => {
  const row = drive({ alpha: 'a\n', beta: 'b\n' });
  assert.strictEqual(row[1], '42', 'seconds-open must come from the captured open timestamp');
});

test('a missing cache is recorded, not fatal', () => {
  // A host that has never been fetched has no cache file at all. stat fails; the picker must
  // not -- this runs from the EXIT trap, on the way out.
  const row = drive({});
  assert.ok(row, 'a picker with no remote caches at all must still log its line');
  assert.strictEqual(row[2], 'no', 'absent on both sides is "nothing changed", not an error');
});

test('what the startup refresh pulled in is not a change', () => {
  // The bug this fix exists for. The remote had moved since the last look, the detached startup
  // refresh brought that in, and nothing moved afterwards. Against an open-time baseline that
  // logs `yes` -- and did, on pickers open for two seconds.
  const { row } = driveSettled(
    { alpha: 'stale\n', beta: 'b\n' },
    { alpha: 'fresh\n', beta: 'b\n' },
    { alpha: 'fresh\n', beta: 'b\n' },
  );
  assert.strictEqual(row[2], 'no', 'the startup refresh landing is not a row changing under you');
  assert.strictEqual(row[3], 'settled', 'and the sample must say which baseline it used');
});

test('a change after the snapshot settles still counts', () => {
  // The other direction: the fix must not blind the measurement it exists to make honest.
  const { row } = driveSettled(
    { alpha: 'stale\n', beta: 'b\n' },
    { alpha: 'fresh\n', beta: 'b\n' },
    { alpha: 'fresher\n', beta: 'b\n' },
  );
  assert.strictEqual(row[2], 'yes', 'a row that moved after the baseline is the real signal');
});

test('with no settled baseline the sample falls back and says so', () => {
  // ssh down, or the startup refresh never finished. Recording it as `open` keeps those samples
  // separable rather than averaging them in with the ones that mean something.
  const { row } = driveSettled(
    { alpha: 'stale\n', beta: 'b\n' },
    { alpha: 'fresh\n', beta: 'b\n' },
    { alpha: 'fresh\n', beta: 'b\n' },
    { writeBaseline: false },
  );
  assert.strictEqual(row[3], 'open', 'a sample without a settled baseline must be marked');
  assert.strictEqual(row[2], 'yes', 'and it keeps the old, over-reporting comparison');
});

test('the baseline file does not outlive the picker', () => {
  const { baselineLeft } = driveSettled({ alpha: 'a\n' }, { alpha: 'b\n' }, { alpha: 'b\n' });
  assert.strictEqual(baselineLeft, false, 'av_log_dwell must clean up the baseline it consumed');
});

test('CTRL+F does not reset the baseline', () => {
  // A manual refresh is evidence that the data felt stale, so it must not overwrite the
  // baseline and hide the very change that prompted it. First writer wins.
  const home = scratch('dwell-ctrlf-');
  const portfile = path.join(home, 'port');
  const cache = path.join(home, '.agentview-remote-cache.alpha');
  const preamble = `
    set -u
    export HOME=${JSON.stringify(home)}
    declare -A HOST_SSH=( [alpha]="alpha" )
    source ${JSON.stringify(LIB)}/common.sh
  `;
  fs.writeFileSync(cache, 'first\n');
  execFileSync('bash', ['-c', `${preamble}
    av_write_dwell_baseline ${JSON.stringify(portfile)}`], { encoding: 'utf8' });
  const afterStartup = fs.readFileSync(`${portfile}.fp`, 'utf8');

  fs.writeFileSync(cache, 'second\n');
  execFileSync('bash', ['-c', `${preamble}
    av_write_dwell_baseline ${JSON.stringify(portfile)}`], { encoding: 'utf8' });

  assert.strictEqual(fs.readFileSync(`${portfile}.fp`, 'utf8'), afterStartup,
    'a second refresh must leave the startup baseline in place');
});
