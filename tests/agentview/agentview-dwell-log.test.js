// Slice 1b instrumentation: does a remote row ever change while a picker is open?
//
// refresh_one_remote rewrites a host's cache only when its content changed, so a moved
// fingerprint means a moved row -- no parsing, no diffing, two stats and a comparison. Dwell
// time alone would not answer the question: a picker open for ten minutes during which nothing
// remote moved argues against streaming just as strongly as one open for five seconds.
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
    _av_open_ts=$(( $(date +%s) - 42 ))
    av_log_dwell
  `], { encoding: 'utf8' });

  const log = path.join(home, '.claude', 'agent-view-dwell.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\t') : null;
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
