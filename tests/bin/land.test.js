// Regression guard for bin/land.
// The refusals are the safety property — land is the one tool here allowed to
// rewrite a remote branch, so each guard that stops it doing so on the wrong
// branch, a dirty tree, or a half-finished rebase is worth pinning. The landing
// itself is covered too, against a bare repo on disk standing in for origin and
// a stub gh: real fetch/rebase/push/delete, no network, no GitHub. Skips without
// bash/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');

const LAND = path.join(__dirname, '..', '..', 'bin', 'land');

const skip = skipUnless('bash', 'git');

// Strip every GIT_* var, then point git at no global or system config. Both the fixtures and
// bin/land's own rebase run under this, so nothing here inherits the machine's identity, hooks,
// templates or commit signing — the signing in particular would send each commit to an agent
// for an approval no test can give.
// PLANKA_TRACKING is here for the same reason: land now calls `planka card move`
// and `planka card comment` after a successful merge, and those reach the real
// local board. The fixtures land a branch called `feature`, so without this every
// run of this suite hits the operator's live Kanban board — and would move a real
// card to Done if one ever existed for that name.
const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  PLANKA_TRACKING: '0',
};

// Stub gh: reports an open PR only when STUB_PR is set, answers the draft check
// from STUB_DRAFT, and records every call that would change something — reads
// stay unrecorded, so the tests can still prove --dry-run made no changes.
// STUB_OPEN_FOR makes the state check answer OPEN that many times before settling
// on STUB_PR_STATE, standing in for GitHub taking a moment to mark a PR merged.
//
// STUB_LOCK turns the stub into the lock probe for the two fd tests below. It runs
// mid-landing, as a child of land, which is exactly the vantage point that matters:
// it records whether the lock is visibly held from outside, and forks a `sleep` that
// outlives the landing the way `git credential-cache--daemon` does.
const BIN = scratch(os.tmpdir(), 'land-bin-');
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/bash
if [ -n "\${STUB_LOCK:-}" ] && [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  flock -n "\$STUB_LOCK" -c true; printf '%s' "\$?" > "\$STUB_LOCK_PROBE"
  # stdio detached, fd 9 deliberately not: inheriting the lock is the whole point,
  # and holding the caller's stdout open would just hang the test harness. The real
  # credential daemon detaches its stdio too, for the same reason.
  sleep 30 >/dev/null 2>&1 </dev/null &
  printf '%s' "\$!" > "\$STUB_DAEMON_PID"
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' "\${STUB_PR:-}"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *state*)
      seen=0
      [ -f "$STUB_STATE_SEEN" ] && seen=\$(cat "$STUB_STATE_SEEN")
      seen=\$((seen + 1))
      printf '%s' "\$seen" > "$STUB_STATE_SEEN"
      if [ "\$seen" -le "\${STUB_OPEN_FOR:-0}" ]; then
        printf 'OPEN\\n'
      else
        printf '%s\\n' "\${STUB_PR_STATE:-MERGED}"
      fi
      ;;
    *) printf '%s\\n' "\${STUB_DRAFT:-false}" ;;
  esac
  exit 0
fi
echo "gh $*" >> "$STUB_GH_CALLS"
exit 0
`, { mode: 0o755 });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

function makeRepo() {
  const dir = scratch(os.tmpdir(), 'land-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'f'), 'y\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  return dir;
}

// A bare repo on disk plays origin, so a whole landing — fetch, rebase, push,
// delete — runs for real with nothing stubbed but gh.
function makeRepoWithOrigin() {
  const base = scratch(os.tmpdir(), 'land-remote-');
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'f'), 'y\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  git(dir, 'push', '-q', '-u', 'origin', 'feature');
  return { base, dir, origin };
}

const ghCalls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const remoteHas = (dir, branch) => git(dir, 'ls-remote', '--heads', 'origin', branch) !== '';

function land(cwd, args = [], { pr = '7', draft = 'false', state = 'MERGED', openFor = '0', lock = null } = {}) {
  const calls = path.join(cwd, '.gh-calls');
  const probe = { held: path.join(cwd, '.lock-probe'), pid: path.join(cwd, '.daemon-pid') };
  try {
    const stdout = execFileSync('bash', [LAND, ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...CLEAN_ENV, PATH: `${BIN}:${CLEAN_ENV.PATH}`,
        STUB_PR: pr, STUB_DRAFT: draft, STUB_PR_STATE: state, STUB_GH_CALLS: calls,
        STUB_OPEN_FOR: openFor, STUB_STATE_SEEN: path.join(cwd, '.gh-state-seen'),
        LAND_POLL_INTERVAL: '0.05',
        ...(lock ? { STUB_LOCK: lock, STUB_LOCK_PROBE: probe.held, STUB_DAEMON_PID: probe.pid } : {}),
      },
    });
    return { code: 0, stdout, stderr: '', calls, probe };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '', calls, probe };
  }
}

test('refuses to land the integration branch', { skip }, () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', 'main');
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /refusing to land main/);
});

test('refuses a branch that is not checked out here', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, ['other']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not checked out here/);
});

test('refuses a dirty worktree, because the rebase needs it clean', { skip }, () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'f'), 'dirty\n');
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /dirty/);
});

test('refuses when there is no open PR to be the record', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, [], { pr: '' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no open PR/);
});

test('refuses mid-rebase rather than guessing', { skip }, () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.git', 'rebase-merge'), { recursive: true });
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /rebase is in progress/);
});

test('--dry-run prints the plan and changes nothing', { skip }, () => {
  const repo = makeRepo();
  const before = git(repo, 'rev-parse', 'HEAD');

  const r = land(repo, ['--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /PR #7/);
  assert.match(r.stdout, /force-with-lease/);
  assert.match(r.stdout, /gh pr ready 7/);
  assert.match(r.stdout, /git push origin feature:main/);
  assert.match(r.stdout, /git push origin --delete feature/);
  assert.doesNotMatch(r.stdout, /gh pr merge/, 'the merge no longer goes through gh');

  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), before, 'HEAD moved');
  assert.ok(!fs.existsSync(r.calls), 'no state-changing gh call was made');
});

test('rejects an unknown flag rather than guessing', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, ['--force']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

test('the plan names a lock shared by every worktree of the repo', { skip }, () => {
  const repo = makeRepo();
  const wtRoot = scratch(os.tmpdir(), 'land-wt-');
  const wt = path.join(wtRoot, 'w');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  fs.writeFileSync(path.join(wt, 'g'), 'z\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'side work');

  const fromMain = land(repo, ['--dry-run']);
  const fromWt = land(wt, ['--dry-run']);
  const lockOf = (out) => out.split('\n').find((l) => l.includes('land.lock')).trim();

  // Same lock from both, or two sessions would land concurrently anyway.
  assert.strictEqual(lockOf(fromWt.stdout), lockOf(fromMain.stdout));
});

test('still takes the PR out of draft', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  // The original reason was that GitHub refuses to merge a draft, which no longer
  // applies now that main is fast-forwarded by git rather than merged by GitHub.
  // Kept anyway: background jobs open drafts by convention, and a PR that landed
  // should not still read as one.
  assert.match(ghCalls(r.calls), /gh pr ready 7/);
});

test('leaves a PR that is already out of draft alone', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'false' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(ghCalls(r.calls), /pr ready/);
});

test('deletes the remote branch with git, not gh --delete-branch', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  assert.ok(remoteHas(dir, 'feature'), 'setup: origin should start with the branch');

  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  // gh's --delete-branch checks out the default branch locally, which cannot
  // work when another worktree holds main — and it fails there *after* the
  // merge, so a landing that worked reports as failed and the branch survives.
  assert.doesNotMatch(ghCalls(r.calls), /--delete-branch/);
  assert.ok(!remoteHas(dir, 'feature'), 'origin still holds the landed branch');
});

// The point of the fast-forward. `gh pr merge --rebase` replayed commits into new
// objects with no signature, so main collected unsigned commits on every landing.
// Moving main onto the branch's own ref keeps the objects, and with them the
// signatures — the SHA being identical is what proves nothing was replayed.
test('main lands on the branch tip itself, not a replayed copy', { skip }, () => {
  const { dir, origin } = makeRepoWithOrigin();
  const tip = git(dir, 'rev-parse', 'feature');

  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  const landed = execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8', env: CLEAN_ENV }).trim();
  assert.strictEqual(landed, tip, 'origin/main is the exact commit that was pushed');
  assert.doesNotMatch(ghCalls(r.calls), /pr merge/, 'GitHub never re-created the commits');
});

test('closes the PR itself when GitHub has not marked it merged', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', state: 'OPEN' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(ghCalls(r.calls), /pr close 7/);
});

// The bug this replaced: one check straight after the push read OPEN, so land closed
// a PR GitHub marked MERGED a moment later — the fallback racing what it backs up.
test('waits for GitHub to catch up before closing anything', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', openFor: '2' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /waiting for GitHub/);
  assert.doesNotMatch(ghCalls(r.calls), /pr close/, 'GitHub got there on its own');
});

test('leaves the PR alone when GitHub already marked it merged', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', state: 'MERGED' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(ghCalls(r.calls), /pr close/);
});

test('lands from a linked worktree while the primary holds main', { skip }, () => {
  const { base, dir } = makeRepoWithOrigin();
  git(dir, 'checkout', '-q', 'main');
  const wt = path.join(base, 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'feature');

  const r = land(wt, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /landed feature/);
  assert.ok(!remoteHas(dir, 'feature'), 'origin still holds the landed branch');
});

// --- the lock fd -------------------------------------------------------------
// These two are a pair and only mean something together. The lock has to be held
// against other landers for the whole landing, and held by *nobody* once it ends.
// Fixing either one alone is easy and wrong: closing the fd in the parent would
// pass the leak test while silently removing the mutual exclusion, and that is the
// failure you would not notice until two sessions rebased onto each other.
const fdSkip = skip || skipUnless('flock');

const lockOf = (dir) => path.join(dir, '.git', 'land.lock');

test('the lock is held against other landers for the whole landing', { skip: fdSkip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', lock: lockOf(dir) });
  assert.strictEqual(r.code, 0, r.stderr);

  // The probe ran mid-landing, from a child of land, and asked for the lock by
  // path — a fresh open, so it sees the lock exactly as a second lander would.
  assert.ok(fs.existsSync(r.probe.held), 'the probe never ran');
  assert.strictEqual(fs.readFileSync(r.probe.held, 'utf8'), '1',
    'a second lander could take the lock mid-landing — the mutex is gone');
});

// The leak: `exec 9>"$LOCK"` sets no close-on-exec, so everything land forks
// inherits fd 9 — including `git credential-cache--daemon`, which `git push`
// starts and which by design never exits. It then holds the flock forever and
// every later land blocks at "another worktree is landing" with no lander
// running. Measured 2026-07-30: a daemon from one landing blocked the next one
// 45 minutes later, and the lock path had to be unlinked by hand.
test('a process forked during the landing does not inherit the lock', { skip: fdSkip }, () => {
  const { dir } = makeRepoWithOrigin();
  const lock = lockOf(dir);
  const r = land(dir, [], { draft: 'true', lock });
  assert.strictEqual(r.code, 0, r.stderr);

  const pid = Number(fs.readFileSync(r.probe.pid, 'utf8'));
  try {
    // Still alive, standing in for the credential daemon: the point is that a
    // live process forked mid-landing holds nothing once land has exited.
    assert.doesNotThrow(() => process.kill(pid, 0), 'setup: the stand-in daemon died early');
    assert.ok(fs.existsSync(lock), 'setup: land never created the lock');

    const code = execFileSync('bash', ['-c',
      `flock -n ${JSON.stringify(lock)} -c true; printf '%s' "$?"`], { encoding: 'utf8' });
    assert.strictEqual(code, '0',
      'the lock is still held after land exited — a forked process inherited fd 9');
  } finally {
    try { process.kill(pid, 9); } catch { /* already gone */ }
  }
});

// ---- "landing is not deploying" ----
// land pushes <branch>:main, which moves ORIGIN's main and leaves the local one where it
// was. chezmoi deploys from the primary checkout's working tree, so an apply right after a
// land redeploys the pre-merge file and silently reverts what landed. That was missed three
// times in one day off a header comment alone, hence a line in the output.

test('a successful land reports that local main is behind', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /local main is behind/, `no sync reminder in:\n${r.stdout}`);
  assert.match(r.stdout, /merge --ff-only origin\/main/, 'the reminder must name the fix');
});

test('a land that leaves local main current says nothing', { skip }, () => {
  // Only fires when true -- a reminder printed unconditionally is one that gets ignored.
  const { dir } = makeRepoWithOrigin();
  git(dir, 'branch', '-f', 'main', 'feature');
  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /local main is behind/, 'main was already at the landed tip');
});

test('--help still reaches the usage block', { skip }, () => {
  // The help text is a line-numbered slice of the header (sed -n '2,Np'), so growing the
  // header silently truncates the usage lines off the end. That nearly shipped.
  const r = land(makeRepo(), ['--help']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /land --dry-run/, 'the slice must still include the usage lines');
  assert.match(r.stdout, /LOCAL main is NOT moved/, 'and the local-main warning it was widened for');
});

