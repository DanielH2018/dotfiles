// Regression guard for bin/lib/repo-lock.sh's mkdir fallback, the lock land and try take
// where there is no flock(1) -- every stock Mac. That path used to run the command
// UNLOCKED (#581), so two landings could move main under each other. flock is hidden with
// a `command -v` shim, the same way the sandbox suites hide a tool, so this runs on a Linux
// host too. The flock path itself is covered by try.test.js.
//
// A directory lock survives a killed holder, so staleness is the half that needs proving:
// each stale case is paired with the live case it must not be confused with.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { repoPath } = require('../lib/paths');

const LIB = repoPath('bin', 'lib', 'repo-lock.sh');
const skip = skipUnless('bash');

// Runs with_repo_lock with flock hidden. The body records that it ran, and what the lock
// directory held while it did.
function locked(lock, { waitS = '5', body = 'true' } = {}) {
  const ran = `${lock}.ran`;
  const script = `
command() {
  if [ "\${1:-}" = -v ] && [ "\${2:-}" = flock ]; then return 1; fi
  builtin command "$@"
}
say() { printf 'say: %s\\n' "$1"; }
die() { printf 'die: %s\\n' "$1" >&2; exit 1; }
. ${JSON.stringify(LIB)}
body() { cat ${JSON.stringify(`${lock}.d/pid`)} > ${JSON.stringify(ran)}; ${body}; }
with_repo_lock ${JSON.stringify(lock)} "busy" "no-flock note" body
`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, REPO_LOCK_WAIT_S: waitS }, timeout: 20000,
  });
  return {
    code: r.status, out: r.stdout || '', err: r.stderr || '',
    ran: fs.existsSync(ran), heldBy: fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim() : null,
  };
}

// A pid that is certainly dead: a child that has already exited and been reaped.
function deadPid() {
  const r = spawnSync('bash', ['-c', 'true & echo $!; wait'], { encoding: 'utf8' });
  return r.stdout.trim();
}

function lockPath(t) {
  return path.join(scratch(os.tmpdir(), 'repolock-', t), 'land.lock');
}

test('the body runs under a lock it holds, and the lock is gone afterwards', { skip }, (t) => {
  const lock = lockPath(t);
  const r = locked(lock, { body: 'return 7' });
  assert.strictEqual(r.code, 7, 'the body exit status is returned');
  assert.ok(r.ran, r.err);
  assert.match(r.heldBy, /^\d+$/, 'the holder recorded its pid while the body ran');
  assert.ok(!fs.existsSync(`${lock}.d`), 'the lock is released');
});

test('a live holder is waited on, never broken', { skip }, (t) => {
  const lock = lockPath(t);
  fs.mkdirSync(`${lock}.d`);
  fs.writeFileSync(`${lock}.d/pid`, String(process.pid));
  const r = locked(lock, { waitS: '1' });
  assert.ok(!r.ran, 'the body ran while another live process held the lock');
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /say: busy/);
  assert.match(r.err, /gave up waiting/);
  assert.strictEqual(fs.readFileSync(`${lock}.d/pid`, 'utf8'), String(process.pid),
    'the live holder\'s lock is untouched');
});

test('a lock whose holder died is reclaimed', { skip }, (t) => {
  const lock = lockPath(t);
  fs.mkdirSync(`${lock}.d`);
  fs.writeFileSync(`${lock}.d/pid`, deadPid());
  const r = locked(lock);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.ran);
  assert.match(r.out, /removed a stale lock left by pid/);
});

test('a lock with no pid is busy while fresh and stale after a minute', { skip }, (t) => {
  const fresh = lockPath(t);
  fs.mkdirSync(`${fresh}.d`);
  const waited = locked(fresh, { waitS: '1' });
  assert.ok(!waited.ran, 'a holder between mkdir and its pid write must not be evicted');

  const old = lockPath(t);
  fs.mkdirSync(`${old}.d`);
  const then = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(`${old}.d`, then, then);
  const r = locked(old);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.ran);
  assert.match(r.out, /removed a stale lock with no holder recorded/);
});
