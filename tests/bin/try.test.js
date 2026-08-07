// Regression guard for bin/try.
// Two properties matter here. The refusals — linked worktree, dirty tree, wrong
// branch, non-fast-forward — are what keep the bench from being deployed out of
// somebody else's half-finished state. And the move itself: try exists because git
// lets the primary checkout detach onto a branch a worktree already holds, so that
// is pinned against a real second worktree rather than asserted. chezmoi is stubbed
// to record its calls, so nothing here touches $HOME. Skips without bash/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRY = path.join(__dirname, '..', '..', 'bin', 'try');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v git'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/git unavailable';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const dirs = [];

// Stub chezmoi: records every call, so a test can prove apply was reached — or
// prove it was not, which is the whole point of --diff and --dry-run. STUB_STATUS
// stands in for a target that something other than chezmoi wrote.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'try-bin-'));
dirs.push(BIN);
//
// STUB_LOCK turns the stub into the lock probe for the fd test below. `chezmoi apply`
// is the deepest point of a bench and runs as a child of try, which is the vantage
// that matters: it records whether the lock is visibly held from outside, and forks a
// `sleep` that outlives the bench the way a daemon started by a run_ script would.
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
echo "chezmoi $*" >> "$STUB_CHEZMOI_CALLS"
if [ "$1" = status ]; then
  [ -z "\${STUB_STATUS:-}" ] || printf '%s\\n' "$STUB_STATUS"
fi
if [ -n "\${STUB_LOCK:-}" ] && [ "$1" = apply ]; then
  flock -n "\$STUB_LOCK" -c true; printf '%s' "\$?" > "\$STUB_LOCK_PROBE"
  # stdio detached, fd 9 deliberately not: inheriting the lock is the whole point,
  # and holding the caller's stdout open would just hang the test harness.
  sleep 30 >/dev/null 2>&1 </dev/null &
  printf '%s' "\$!" > "\$STUB_DAEMON_PID"
fi
exit 0
`, { mode: 0o755 });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

// A repo whose feature branch is held by a linked worktree — the situation try is
// for. `origin` is a bare repo on disk so the ahead-of-origin notice has a remote
// to compare against.
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'try-repo-'));
  dirs.push(base);
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'branch', 'feature');
  const wt = path.join(base, 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'feature');
  fs.writeFileSync(path.join(wt, 'f'), 'y\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  return { dir, wt };
}

const calls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const branchOf = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

// The calls file lives outside the repo on purpose: dropped inside it, it would
// itself make the tree dirty and trip try's own guard on the next invocation.
function run(cwd, args = [], extraEnv = {}) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'try-calls-'));
  dirs.push(box);
  const file = path.join(box, 'calls');
  try {
    const stdout = execFileSync('bash', [TRY, ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...CLEAN_ENV, PATH: `${BIN}:${CLEAN_ENV.PATH}`, STUB_CHEZMOI_CALLS: file, ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr: '', file };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '', file };
  }
}

test('refuses to run from a linked worktree', { skip }, () => {
  const { wt } = makeRepo();
  const r = run(wt, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /linked worktree — run try from the primary checkout/);
});

test('refuses a dirty primary checkout, which is usually another session', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README'), 'dirty\n');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /primary checkout is dirty/);
  assert.strictEqual(branchOf(dir), 'main');
});

test('refuses an unknown branch', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['nope']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no such branch: nope/);
});

test('refuses to try the bench itself', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['main']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /main is the bench/);
});

test('refuses a branch with no branch named', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /which branch\?/);
});

test('refuses two branches at once', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature', 'other']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /one branch at a time/);
});

test('rejects an unknown flag', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['--nope']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /unknown flag --nope/);
});

test('--dry-run moves nothing and deploys nothing', { skip }, () => {
  const { dir } = makeRepo();
  const before = head(dir);
  const r = run(dir, ['feature', '--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /git checkout --detach feature/);
  assert.strictEqual(head(dir), before);
  assert.strictEqual(calls(r.file), '');
});

// The property try is built on: the primary checkout can reach a branch that is
// checked out in another worktree, as long as it detaches to do it.
test('detaches onto a branch a worktree already holds, then deploys', { skip }, () => {
  const { dir, wt } = makeRepo();
  const target = git(dir, 'rev-parse', 'feature');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(head(dir), target);
  assert.strictEqual(branchOf(dir), 'HEAD'); // detached, so main is untouched
  assert.strictEqual(git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'origin/main'));
  assert.match(calls(r.file), /chezmoi diff/);
  assert.match(calls(r.file), /chezmoi apply/);
  // The worktree that owns the branch is left exactly as it was.
  assert.strictEqual(branchOf(wt), 'feature');
  assert.strictEqual(git(wt, 'status', '--porcelain'), '');
});

test('--diff moves HEAD but stops before apply', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature', '--diff']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(head(dir), git(dir, 'rev-parse', 'feature'));
  assert.match(calls(r.file), /chezmoi diff/);
  assert.doesNotMatch(calls(r.file), /chezmoi apply/);
});

test('--merge fast-forwards main and warns it is ahead of origin', { skip }, () => {
  const { dir } = makeRepo();
  const target = git(dir, 'rev-parse', 'feature');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(branchOf(dir), 'main');
  assert.strictEqual(head(dir), target);
  assert.match(r.stdout, /main is 1 commit\(s\) ahead of origin\/main/);
  assert.match(calls(r.file), /chezmoi apply/);
});

test('--merge refuses when main is not checked out here', { skip }, () => {
  const { dir } = makeRepo();
  git(dir, 'checkout', '-q', '--detach', 'feature');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /--merge needs main checked out here/);
});

test('--merge refuses a branch that has diverged from main', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README'), 'moved on\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main moves');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not a fast-forward from main — land it through its PR/);
});

test('--back returns the bench to main and redeploys', { skip }, () => {
  const { dir } = makeRepo();
  assert.strictEqual(run(dir, ['feature']).code, 0);
  assert.strictEqual(branchOf(dir), 'HEAD');
  const r = run(dir, ['--back']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(branchOf(dir), 'main');
  assert.match(calls(r.file), /chezmoi apply/);
});

test('--back takes no branch', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['--back', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /--back takes no branch/);
});

test('notes when the bench is parked on some other branch', { skip }, () => {
  const { dir } = makeRepo();
  git(dir, 'checkout', '-qb', 'parked');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /primary checkout is on parked, not main/);
});

test('refuses while a merge is in progress', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'feature')}\n`);
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /a merge is in progress here/);
});

test('-h prints usage without touching the repo', { skip }, () => {
  const { dir } = makeRepo();
  const before = head(dir);
  const r = run(dir, ['-h']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /bin\/try <branch>\s+detach onto <branch>/);
  assert.match(r.stdout, /bin\/try --back/);
  assert.match(r.stdout, /TRY_APPLY_GUARD=off/, 'the override is documented, not just implemented');
  assert.strictEqual(head(dir), before);
  assert.strictEqual(calls(r.file), '');
});

// chezmoi-apply-guard.sh never sees this apply — it matches the Bash command
// string, which here is `try <branch>` — so try has to make the same refusal
// itself or it becomes the way around the guard.
test('refuses to deploy over a file something other than chezmoi wrote', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature'], { STUB_STATUS: 'MM home/dot_zshrc' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /would overwrite files something other than chezmoi wrote/);
  assert.match(r.stderr, /MM home\/dot_zshrc/);
  assert.match(calls(r.file), /chezmoi status/);
  assert.doesNotMatch(calls(r.file), /chezmoi apply/);
});

test('TRY_APPLY_GUARD=off deploys over it anyway', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature'], { STUB_STATUS: 'MM home/dot_zshrc', TRY_APPLY_GUARD: 'off' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(calls(r.file), /chezmoi apply/);
});

// Only column 2 in [ADM] means apply would overwrite something. A source-side
// change alone — the ordinary case, every edit under home/ — must not block.
test('a source-only change does not count as a conflict', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature'], { STUB_STATUS: ' M home/dot_zshrc' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(calls(r.file), /chezmoi apply/);
});

let flockOk = true;
try { execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' }); } catch { flockOk = false; }

// The lock file is created by with_repo_lock's `exec 9>"$_lock"`, which lives in the flock
// branch: where there is no flock (a stock macOS) try deliberately runs the bench unlocked and
// says so, creating no file. So this asserts something only a flock machine has -- the same
// condition the contention test below already gates on.
test('takes a lock, so two benches cannot interleave', { skip: skip || (flockOk ? false : 'flock unavailable') }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.git', 'try.lock')));
});

test('waits for a bench another worktree is holding', { skip: skip || (flockOk ? false : 'flock unavailable') }, () => {
  const { dir } = makeRepo();
  const lock = path.join(dir, '.git', 'try.lock');
  const marker = path.join(dir, '.git', 'held');
  // The holder announces itself once it actually owns the lock, so the run below
  // is guaranteed to contend rather than racing it for first grab.
  // 0.6s, not 2s: the assertions are that `try` reports contention and still lands, not that
  // it waited any particular length. The marker loop below already guarantees the holder owns
  // the lock first, so this only has to outlast `try`'s startup, which is under 100ms.
  const holder = spawn('flock', [lock, '-c', `touch ${marker}; sleep 0.6`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && !fs.existsSync(marker); i += 1) {
      execFileSync('sleep', ['0.05']);
    }
    assert.ok(fs.existsSync(marker), 'holder never took the lock');
    const r = run(dir, ['feature']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /another worktree is using the bench; waiting/);
    assert.strictEqual(head(dir), git(dir, 'rev-parse', 'feature'));
  } finally {
    holder.kill();
  }
});

// --- the lock fd -------------------------------------------------------------
// The pair below is the same guard tests/land.test.js pins, asked of try. Both now
// go through with_repo_lock, and this is what stops the fd close from being dropped
// on one side of it: land carried `( land ) 9>&-` and try called `bench` bare, so a
// process forked anywhere under `chezmoi apply` inherited the lock and kept holding
// it after try exited. They only mean something together — the lock must be held for
// the whole bench AND released the moment it ends.
test('the lock is held against other benches for the whole bench', { skip: skip || (flockOk ? false : 'flock unavailable') }, () => {
  const { dir } = makeRepo();
  const lock = path.join(dir, '.git', 'try.lock');
  const probe = path.join(dir, '.lock-probe');
  const r = run(dir, ['feature'], { STUB_LOCK: lock, STUB_LOCK_PROBE: probe, STUB_DAEMON_PID: path.join(dir, '.daemon-pid') });
  assert.strictEqual(r.code, 0, r.stderr);
  // The probe ran mid-bench, from a child of try, and asked for the lock by path — a
  // fresh open, so it sees the lock exactly as a second bench would.
  assert.strictEqual(fs.readFileSync(probe, 'utf8'), '1',
    'a second bench could take the lock mid-bench — the mutex is gone');
});

test('a process forked during the bench does not inherit the lock', { skip: skip || (flockOk ? false : 'flock unavailable') }, () => {
  const { dir } = makeRepo();
  const lock = path.join(dir, '.git', 'try.lock');
  const pidFile = path.join(dir, '.daemon-pid');
  const r = run(dir, ['feature'], { STUB_LOCK: lock, STUB_LOCK_PROBE: path.join(dir, '.lock-probe'), STUB_DAEMON_PID: pidFile });
  assert.strictEqual(r.code, 0, r.stderr);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    // Still alive, standing in for a daemon a run_ script left behind: the point is
    // that a live forked child does not keep the lock once try itself has exited.
    assert.doesNotThrow(() => process.kill(pid, 0), 'setup: the stand-in daemon died early');
    assert.ok(fs.existsSync(lock), 'setup: try never created the lock');
    const free = execFileSync('bash', ['-c',
      `flock -n ${JSON.stringify(lock)} -c true; printf '%s' "$?"`], { encoding: 'utf8' });
    assert.strictEqual(free, '0',
      'the lock is still held after try exited — a forked process inherited fd 9');
  } finally {
    try { process.kill(pid); } catch { /* already gone */ }
  }
});

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
